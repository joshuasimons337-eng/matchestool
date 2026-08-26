const DERIV_WS_URL =
  'wss://api.derivws.com/trading/v1/options/ws/public';

let ws = null;
let historyDigits = [];
let liveDigits = [];
let authMode = 'login';
let csrf = '';
let selectedProduct = '';

const $ = id => document.getElementById(id);

const status = (text, connected = false) => {
  const el = $('status');

  if (!el) return;

  el.innerHTML =
    `<span class="dot ${connected ? 'on' : ''}"></span>${text}`;
};

function lastDigit(quote) {
  const clean = String(quote).replace(/[^0-9]/g, '');

  if (!clean) {
    return null;
  }

  return Number(clean.slice(-1));
}


/* =========================================================
   MATCHES PREDICTION ENGINE
   ========================================================= */

const MATCH_BASELINE = 10;


function predictMode(history, windowSize = 50) {
  if (history.length < windowSize) {
    return null;
  }

  const counts = Array(10).fill(0);

  const start =
    history.length - windowSize;

  for (let i = start; i < history.length; i++) {
    const digit = history[i];

    if (
      Number.isInteger(digit) &&
      digit >= 0 &&
      digit <= 9
    ) {
      counts[digit]++;
    }
  }

  let best = 0;

  for (let d = 1; d < 10; d++) {
    if (counts[d] > counts[best]) {
      best = d;
    }
  }

  return best;
}


function predictWeighted(history, windowSize = 50) {
  if (history.length < windowSize) {
    return null;
  }

  const scores = Array(10).fill(0);

  const start =
    history.length - windowSize;

  for (let i = start; i < history.length; i++) {
    const digit = history[i];

    if (
      !Number.isInteger(digit) ||
      digit < 0 ||
      digit > 9
    ) {
      continue;
    }

    const age = i - start;

    const weight =
      1 + age / windowSize;

    scores[digit] += weight;
  }

  let best = 0;

  for (let d = 1; d < 10; d++) {
    if (scores[d] > scores[best]) {
      best = d;
    }
  }

  return best;
}


function predictTransition(history) {
  if (history.length < 2) {
    return null;
  }

  const previous =
    history[history.length - 1];

  const counts =
    Array(10).fill(0);

  for (let i = 1; i < history.length; i++) {
    if (history[i - 1] === previous) {
      const digit = history[i];

      if (
        Number.isInteger(digit) &&
        digit >= 0 &&
        digit <= 9
      ) {
        counts[digit]++;
      }
    }
  }

  const total =
    counts.reduce(
      (a, b) => a + b,
      0
    );

  if (total === 0) {
    return predictMode(history, 50);
  }

  let best = 0;

  for (let d = 1; d < 10; d++) {
    if (counts[d] > counts[best]) {
      best = d;
    }
  }

  return best;
}


/* =========================================================
   SCORE A MODEL
   ========================================================= */

function scoreMatchModel(
  ds,
  predictor,
  start,
  end
) {
  let correct = 0;
  let total = 0;

  const first =
    Math.max(0, start);

  const last =
    Math.min(ds.length, end);

  for (let i = first; i < last; i++) {

    const history =
      ds.slice(0, i);

    const prediction =
      predictor(history);

    if (
      prediction === null ||
      prediction === undefined
    ) {
      continue;
    }

    if (prediction === ds[i]) {
      correct++;
    }

    total++;
  }

  return {
    correct,
    total,
    accuracy:
      total
        ? (correct / total) * 100
        : null
  };
}


/* =========================================================
   SELECT MATCH MODEL
   IMPORTANT:
   70% TRAINING
   30% UNSEEN TEST
   ========================================================= */

function selectMatchModel(ds) {

  const MIN_HISTORY = 50;

  if (ds.length <= MIN_HISTORY) {

    const predictor =
      history =>
        predictMode(history, 50);

    return {
      name: 'Mode-50',
      predictor,
      training: null,
      test: null,
      candidates: []
    };
  }


  const split =
    Math.floor(ds.length * 0.70);


  const models = [

    {
      name: 'Transition',
      predictor: predictTransition
    },

    {
      name: 'Mode-20',
      predictor:
        history =>
          predictMode(history, 20)
    },

    {
      name: 'Mode-50',
      predictor:
        history =>
          predictMode(history, 50)
    },

    {
      name: 'Weighted-50',
      predictor:
        history =>
          predictWeighted(history, 50)
    }

  ];


  const scored =
    models.map(model => {

      const training =
        scoreMatchModel(
          ds,
          model.predictor,
          MIN_HISTORY,
          split
        );


      const test =
        scoreMatchModel(
          ds,
          model.predictor,
          split,
          ds.length
        );


      return {
        ...model,
        training,
        test
      };
    });


  /*
   * IMPORTANT:
   * The winner is selected using TRAINING
   * performance only.
   *
   * The unseen test set is NOT used
   * to select the model.
   */

  scored.sort(
    (a, b) =>
      (b.training.accuracy ?? -Infinity) -
      (a.training.accuracy ?? -Infinity)
  );


  const winner =
    scored[0];


  return {

    name:
      winner.name,

    predictor:
      winner.predictor,

    training:
      winner.training,

    test:
      winner.test,

    candidates:
      scored

  };
}


/* =========================================================
   BACKTEST
   ========================================================= */

function backtest(
  ds,
  windowSize = 50
) {

  if (ds.length <= windowSize) {

    return {
      m: null,
      p: null,
      o: null,

      matchModel: null,

      matchBaseline:
        MATCH_BASELINE,

      matchTraining: null,

      matchTest: null,

      candidates: []
    };
  }


  const match =
    selectMatchModel(ds);


  let parityCorrect = 0;

  let overUnderCorrect = 0;

  let total = 0;


  for (
    let i = windowSize;
    i < ds.length;
    i++
  ) {

    const h =
      ds.slice(
        i - windowSize,
        i
      );

    const actual =
      ds[i];


    const even =
      h.filter(
        d => d % 2 === 0
      ).length >=
      Math.ceil(
        h.length / 2
      );


    const over =
      h.filter(
        d => d >= 5
      ).length >=
      Math.ceil(
        h.length / 2
      );


    if (
      (actual % 2 === 0) === even
    ) {
      parityCorrect++;
    }


    if (
      (actual >= 5) === over
    ) {
      overUnderCorrect++;
    }


    total++;
  }


  return {

    m:
      match.test?.accuracy ??
      null,

    p:
      total
        ? (parityCorrect / total) * 100
        : null,

    o:
      total
        ? (overUnderCorrect / total) * 100
        : null,

    matchModel:
      match.name,

    matchBaseline:
      MATCH_BASELINE,

    matchTraining:
      match.training?.accuracy ??
      null,

    matchTest:
      match.test?.accuracy ??
      null,

    candidates:
      match.candidates || []

  };
}


/* =========================================================
   RENDER DASHBOARD
   ========================================================= */

function render() {
  const r = backtest(historyDigits);

  /*
   * =======================================================
   * MAIN ACCURACY CARDS
   * =======================================================
   */

  if ($('matchAcc')) {
    $('matchAcc').textContent =
      r.m == null
        ? '-'
        : r.m.toFixed(1) + '%';
  }

  if ($('evenAcc')) {
    $('evenAcc').textContent =
      r.p == null
        ? '-'
        : r.p.toFixed(1) + '%';
  }

  if ($('ouAcc')) {
    $('ouAcc').textContent =
      r.o == null
        ? '-'
        : r.o.toFixed(1) + '%';
  }


  /*
   * =======================================================
   * HEADLINE ACCURACY
   * =======================================================
   */

  const values = [r.m, r.p, r.o].filter(
    x => typeof x === 'number'
  );

  if ($('headlineAccuracy')) {
    $('headlineAccuracy').textContent =
      values.length
        ? (
            values.reduce(
              (a, b) => a + b,
              0
            ) / values.length
          ).toFixed(1) + '%'
        : '-';
  }


  /*
   * =======================================================
   * MATCH MODEL COMPARISON TABLE
   * =======================================================
   */

  const body = $('matchComparisonBody');

  if (body) {

    if (
      !r.candidates ||
      !r.candidates.length
    ) {

      body.innerHTML = `
        <tr>
          <td
            colspan="4"
            class="muted"
            style="padding:12px"
          >
            Waiting for enough historical data
            to compare models.
          </td>
        </tr>
      `;

    } else {

      body.innerHTML =
        r.candidates
          .map(model => {

            const training =
              model.training?.accuracy == null
                ? '-'
                : model.training.accuracy
                    .toFixed(1) + '%';

            const test =
              model.test?.accuracy == null
                ? '-'
                : model.test.accuracy
                    .toFixed(1) + '%';

            let difference = '-';

            if (
              model.test?.accuracy != null
            ) {

              const delta =
                model.test.accuracy -
                MATCH_BASELINE;

              difference =
                (delta >= 0 ? '+' : '') +
                delta.toFixed(1) +
                '%';
            }

            return `
              <tr
                style="
                  border-bottom:
                  1px solid var(--line)
                "
              >

                <td style="padding:10px">
                  <strong>
                    ${model.name}
                  </strong>
                </td>

                <td style="padding:10px">
                  ${training}
                </td>

                <td style="padding:10px">
                  ${test}
                </td>

                <td style="padding:10px">
                  ${difference}
                </td>

              </tr>
            `;
          })
          .join('');
    }
  }


  /*
   * =======================================================
   * MATCH MODEL CONCLUSION
   * =======================================================
   */

  const conclusion = $('matchConclusion');

  if (conclusion) {

    /*
     * We use the selected model's test result.
     *
     * If the model has been selected and tested,
     * show the result.
     */

    if (
  r.matchModel &&
  r.matchTest &&
  r.matchTest.accuracy != null
) {
  const accuracy = r.matchTest.accuracy;
  const difference = accuracy - MATCH_BASELINE;

  if (difference > 0) {
    conclusion.className = 'notice success';

    conclusion.textContent =
      `Selected model: ${r.matchModel}. ` +
      `Unseen test accuracy was ${accuracy.toFixed(1)}%, ` +
      `which is ${difference.toFixed(1)} percentage points ` +
      `above the 10% exact-digit baseline. ` +
      `This is evidence of improvement, ` +
      `not proof of a persistent trading edge.`;

  } else if (difference === 0) {
    conclusion.className = 'notice';

    conclusion.textContent =
      `Selected model: ${r.matchModel}. ` +
      `Unseen test accuracy was exactly 10.0%, ` +
      `equal to the 10% exact-digit baseline. ` +
      `No demonstrated Matches edge yet.`;

  } else {
    conclusion.className = 'notice error';

    conclusion.textContent =
      `Selected model: ${r.matchModel}. ` +
      `Unseen test accuracy was ${accuracy.toFixed(1)}%, ` +
      `which was ${Math.abs(difference).toFixed(1)} ` +
      `percentage points below the 10% exact-digit baseline. ` +
      `No demonstrated Matches edge yet.`;
  }

} else if (r.candidates && r.candidates.length) {

  conclusion.className = 'notice';

  conclusion.textContent =
    `Backtest comparison complete. ` +
    `Selected model: ${r.matchModel || 'pending'}. ` +
    `Waiting for a valid unseen-test result.`;

} else {

  conclusion.className = 'notice';

  conclusion.textContent =
    'Waiting for enough historical data to compare models.';
}


  /*
   * =======================================================
   * LIVE SIGNAL
   * =======================================================
   */

  const combined =
    historyDigits.concat(
      liveDigits
    );

  const h =
    combined.slice(-50);


  if ( h.length && $('signalBox')) {

    /*
     * IMPORTANT:
     *
     * The live prediction uses the same model-selection
     * process as the backtest when enough history exists.
     */

    let matchPrediction;

    if (combined.length >= 100) {

      matchPrediction =
        selectMatchModel(combined);

    } else {

      matchPrediction = {
        name: 'Mode-50',

        predictor:
          history =>
            predictMode(
              history,
              50
            )
      };
    }


    const pd =
      matchPrediction &&
      matchPrediction.predictor
        ? matchPrediction.predictor(combined)
        : null;


    const even =
      h.filter(
        d => d % 2 === 0
      ).length >=
      Math.ceil(
        h.length / 2
      );


    const over =
      h.filter(
        d => d >= 5
      ).length >=
      Math.ceil(
        h.length / 2
      );


    $('signalBox').innerHTML =
      `Signal: ` +
      `<b>Match ${
        pd == null ? '-' : pd
      }</b> · ` +
      `<b>${
        even ? 'EVEN' : 'ODD'
      }</b> · ` +
      `<b>${
        over ? 'OVER 4' : 'UNDER 5'
      }</b> ` +
      `<span class="muted">` +
      `Matches model: ${
        matchPrediction?.name || 'Mode-50'
      }` +
      `</span>`;
  }
}

}


/* =========================================================
   LOAD HISTORICAL DATA
   ========================================================= */

async function loadHistory(symbol) {

  try {

    const response =
      await fetch(
        '/api/history?symbol=' +
        encodeURIComponent(symbol)
      );


    const data =
      await response.json();


    if (!response.ok) {

      console.error(
        'History request failed:',
        data
      );

      return;
    }


    if (data.prices) {

      historyDigits =
        data.prices
          .map(lastDigit)
          .filter(
            digit =>
              digit !== null
          );


      console.log(
        'Historical ticks loaded:',
        historyDigits.length
      );


      render();
    }

  } catch (error) {

    console.error(
      'History request failed:',
      error
    );
  }
}


/* =========================================================
   DERIV CONNECTION
   ========================================================= */

function connect() {

  const symbolElement =
    $('symbol');


  if (!symbolElement) {
    return;
  }


  const symbol =
    symbolElement.value;


  if (ws) {

    try {
      ws.close();
    } catch (error) {
      console.error(error);
    }
  }


  historyDigits = [];

  liveDigits = [];


  status(
    'Connecting...'
  );


  ws =
    new WebSocket(
      DERIV_WS_URL
    );


  ws.onopen =
    async () => {

      status(
        'Connected',
        true
      );


      await loadHistory(
        symbol
      );


      ws.send(
        JSON.stringify({
          ticks: symbol,
          subscribe: 1,
          req_id: 2
        })
      );
    };


  ws.onmessage =
    event => {

      let data;


      try {

        data =
          JSON.parse(
            event.data
          );

      } catch (error) {

        return;
      }


      if (data.error) {

        console.error(
          'Deriv API error:',
          data.error
        );


        status(
          'API error'
        );


        return;
      }


      if (
        data.msg_type === 'tick' &&
        data.tick
      ) {

        const quote =
          data.tick.quote;


        const digit =
          lastDigit(
            quote
          );


        if ($('latest')) {

          $('latest').textContent =
            quote;
        }


        if ($('digit')) {

          $('digit').textContent =
            digit === null
              ? '-'
              : digit;
        }


        if (
          digit !== null
        ) {

          liveDigits.push(
            digit
          );


          if (
            liveDigits.length > 50
          ) {

            liveDigits.shift();
          }


          render();
        }
      }
    };


  ws.onerror =
    error => {

      console.error(
        'WebSocket error:',
        error
      );


      status(
        'Connection error'
      );
    };


  ws.onclose =
    () => {

      status(
        'Disconnected'
      );
    };
}


/* =========================================================
   AUTHENTICATION
   ========================================================= */

function setAuthMode(mode) {

  authMode =
    mode;


  if ($('loginTab')) {

    $('loginTab')
      .classList
      .toggle(
        'primary',
        mode === 'login'
      );
  }


  if ($('registerTab')) {

    $('registerTab')
      .classList
      .toggle(
        'primary',
        mode === 'register'
      );
  }


  if ($('authSubmit')) {

    $('authSubmit')
      .textContent =
        mode === 'login'
          ? 'Sign in'
          : 'Create account';
  }


  if ($('password')) {

    $('password')
      .setAttribute(
        'autocomplete',
        mode === 'login'
          ? 'current-password'
          : 'new-password'
      );
  }
}


async function submitAuth(event) {

  event.preventDefault();


  const email =
    $('email').value.trim();


  const password =
    $('password').value;


  if (
    !email ||
    !password
  ) {

    $('authStatus').className =
      'notice error';


    $('authStatus').textContent =
      'Please enter your email and password.';


    return;
  }


  if (
    authMode === 'register' &&
    password.length < 10
  ) {

    $('authStatus').className =
      'notice error';


    $('authStatus').textContent =
      'Password must be at least 10 characters.';


    return;
  }


  $('authSubmit').disabled =
    true;


  $('authSubmit').textContent =
    authMode === 'login'
      ? 'Signing in...'
      : 'Creating account...';


  try {

    const response =
      await fetch(
        '/api/auth/' +
        (
          authMode === 'login'
            ? 'login'
            : 'register'
        ),
        {
          method: 'POST',

          headers: {
            'content-type':
              'application/json'
          },

          body:
            JSON.stringify({
              email,
              password
            })
        }
      );


    let data;


    try {

      data =
        await response.json();

    } catch (error) {

      data = {
        error:
          'The server returned an invalid response.'
      };
    }


    if (!response.ok) {

      $('authStatus').className =
        'notice error';


      $('authStatus').textContent =
        data.error ||
        'Authentication failed.';


      return;
    }


    $('authStatus').className =
      'notice success';


    $('authStatus').textContent =
      data.message ||
      (
        authMode === 'register'
          ? 'Account created successfully.'
          : 'Signed in successfully.'
      );


    await loadMe();

  } catch (error) {

    console.error(
      'Authentication error:',
      error
    );


    $('authStatus').className =
      'notice error';


    $('authStatus').textContent =
      'Unable to connect to the server. Please try again.';

  } finally {

    $('authSubmit').disabled =
      false;


    $('authSubmit').textContent =
      authMode === 'login'
        ? 'Sign in'
        : 'Create account';
  }
}


async function loadMe() {

  try {

    const response =
      await fetch(
        '/api/auth/me'
      );


    if (!response.ok) {

      if ($('authCard')) {

        $('authCard')
          .classList
          .remove('hidden');
      }


      if ($('accountPanel')) {

        $('accountPanel')
          .classList
          .add('hidden');
      }


      return false;
    }


    const data =
      await response.json();


    csrf =
      data.csrf || '';


    if ($('accountEmail')) {

      $('accountEmail')
        .textContent =
        data.user.email;
    }


    if ($('entMatches')) {

      $('entMatches')
        .textContent =
          data.entitlements.matches
            ? 'Unlocked'
            : 'Locked';
    }


    if ($('entOU')) {

      $('entOU')
        .textContent =
          data.entitlements.overUnder
            ? 'Unlocked'
            : 'Locked';
    }


    if ($('entFull')) {

      $('entFull')
        .textContent =
          data.entitlements.fullAccess
            ? 'Unlocked'
            : 'Locked';
    }


    if ($('authCard')) {

      $('authCard')
        .classList
        .add('hidden');
    }


    if ($('accountPanel')) {

      $('accountPanel')
        .classList
        .remove('hidden');
    }


    return true;

  } catch (error) {

    console.error(
      'Could not load account:',
      error
    );


    return false;
  }
}


async function logout() {

  try {

    await fetch(
      '/api/auth/logout',
      {
        method: 'POST'
      }
    );

  } catch (error) {

    console.error(
      error
    );
  }


  csrf = '';


  await loadMe();
}


/* =========================================================
   PAYMENTS
   ========================================================= */

function selectProduct(product) {

  selectedProduct =
    product;


  if (!$('selectedProduct')) {
    return;
  }


  if (
    product === 'full'
  ) {

    $('selectedProduct').value =
      'Full Access - $200';

  } else if (
    product === 'matches'
  ) {

    $('selectedProduct').value =
      'Matches - $100';

  } else {

    $('selectedProduct').value =
      'Over/Under - $100';
  }


  location.hash =
    'payment';
}


async function submitPayment() {

  if (!csrf) {

    $('payStatus').className =
      'notice error';


    $('payStatus').textContent =
      'Please sign in first.';


    location.hash =
      'account';


    return;
  }


  if (!selectedProduct) {

    $('payStatus').className =
      'notice error';


    $('payStatus').textContent =
      'Select a product first.';


    return;
  }


  const transactionHash =
    $('tx').value.trim();


  if (
    !/^[a-fA-F0-9]{64}$/
      .test(transactionHash)
  ) {

    $('payStatus').className =
      'notice error';


    $('payStatus').textContent =
      'Enter a valid 64-character transaction hash.';


    return;
  }


  $('payBtn').disabled =
    true;


  $('payBtn').textContent =
    'Verifying...';


  try {

    const response =
      await fetch(
        '/api/payments/verify',
        {
          method: 'POST',

          headers: {
            'content-type':
              'application/json',

            'x-csrf-token':
              csrf
          },

          body:
            JSON.stringify({
              product:
                selectedProduct,

              txHash:
                transactionHash
            })
        }
      );


    const data =
      await response.json();


    $('payStatus').className =
      'notice ' +
      (
        response.ok
          ? 'success'
          : 'error'
      );


    $('payStatus').textContent =
      data.message ||
      data.error ||
      'Verification response received.';


    if (response.ok) {

      await loadMe();
    }

  } catch (error) {

    console.error(
      'Payment verification error:',
      error
    );


    $('payStatus').className =
      'notice error';


    $('payStatus').textContent =
      'Unable to contact the payment verification server.';

  } finally {

    $('payBtn').disabled =
      false;


    $('payBtn').textContent =
      'Submit Payment Hash';
  }
}


/* =========================================================
   INITIALIZE
   ========================================================= */

function initialize() {

  if ($('start')) {

    $('start')
      .addEventListener(
        'click',
        connect
      );
  }


  if ($('loginTab')) {

    $('loginTab')
      .addEventListener(
        'click',
        () =>
          setAuthMode('login')
      );
  }


  if ($('registerTab')) {

    $('registerTab')
      .addEventListener(
        'click',
        () =>
          setAuthMode('register')
      );
  }


  if ($('authForm')) {

    $('authForm')
      .addEventListener(
        'submit',
        submitAuth
      );
  }


  if ($('logout')) {

    $('logout')
      .addEventListener(
        'click',
        logout
      );
  }


  document
    .querySelectorAll(
      '[data-product]'
    )
    .forEach(
      button => {

        button.addEventListener(
          'click',
          () => {

            selectProduct(
              button.dataset.product
            );
          }
        );
      }
    );


  if ($('payBtn')) {

    $('payBtn')
      .addEventListener(
        'click',
        submitPayment
      );
  }


  setAuthMode(
    'login'
  );


  loadMe();
}


if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialize);
} else {
  initialize();
}
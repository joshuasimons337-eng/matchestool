(() => {
  const WS_URL = "wss://api.derivws.com/trading/v1/options/ws/public";
  const HISTORY_SIZE = 100;
  const PREDICTION_SECONDS = 10;
  const ENTRY_SECONDS = 5;
  const TRADE_NOW_SECONDS = 3;

  const mode = document.body.dataset.dashboardMode || "matches";
  const states = new Map();
  let connectedCount = 0;

  const $all = (selector, root = document) => [...root.querySelectorAll(selector)];
  const lastDigit = value => {
    const text = String(value ?? "");
    const match = text.match(/(\d)(?!.*\d)/);
    return match ? Number(match[1]) : null;
  };

  function recentRunLength(digits, classifier, predictedValue) {
    let run = 0;
    for (let i = digits.length - 1; i >= 0; i--) {
      if (classifier(digits[i]) === predictedValue) run += 1;
      else break;
    }
    return run;
  }

  function confluenceFromScore(score) {
    if (score >= 0.78) return { label: "HIGH", level: "high" };
    if (score >= 0.60) return { label: "MEDIUM", level: "medium" };
    return { label: "LOW", level: "low" };
  }

  function recommendedRuns(score, recentRun, modeName) {
    // Variable recommendation based on signal strength and the current streak.
    const base = score >= 0.78 ? 5 : score >= 0.68 ? 4 : score >= 0.60 ? 3 : 2;
    const streakAdjustment = recentRun >= 4 ? 1 : recentRun === 0 ? -1 : 0;
    const cap = modeName === "evenodd" ? 6 : 5;
    return Math.max(1, Math.min(cap, base + streakAdjustment));
  }

  function predictMode(digits, windowSize = 50) {
    const sample = digits.slice(-windowSize);
    if (!sample.length) return { value: null, share: 0 };
    const counts = Array(10).fill(0);
    sample.forEach(d => counts[d]++);
    let best = 0;
    for (let i = 1; i < counts.length; i++) if (counts[i] > counts[best]) best = i;
    return { value: best, share: counts[best] / sample.length };
  }

  function signalFor(digits) {
    const sample = digits.slice(-50);
    if (sample.length < 20) return null;

    if (mode === "matches") {
      const p = predictMode(sample);
      const recent = recentRunLength(sample, d => String(d), String(p.value));
      // Exact digits have a 10% neutral baseline.
      const score = Math.max(0, Math.min(1, (p.share - 0.10) / 0.12));
      const c = confluenceFromScore(score);
      return { value: String(p.value), confluence: c, runs: recommendedRuns(score, recent, mode) };
    }

    if (mode === "evenodd") {
      const even = sample.filter(d => d % 2 === 0).length;
      const odd = sample.length - even;
      const value = even >= odd ? "EVEN" : "ODD";
      const share = Math.max(even, odd) / sample.length;
      const recent = recentRunLength(sample, d => d % 2 === 0 ? "EVEN" : "ODD", value);
      // 50% is the neutral baseline for Even/Odd.
      const score = Math.max(0, Math.min(1, (share - 0.50) / 0.18));
      const c = confluenceFromScore(score);
      return { value, confluence: c, runs: recommendedRuns(score, recent, mode) };
    }

    const over = sample.filter(d => d >= 5).length;
    const under = sample.length - over;
    const value = over >= under ? "OVER 4" : "UNDER 5";
    const share = Math.max(over, under) / sample.length;
    const recent = recentRunLength(sample, d => d >= 5 ? "OVER 4" : "UNDER 5", value);
    // 50% is the neutral baseline for Over/Under.
    const score = Math.max(0, Math.min(1, (share - 0.50) / 0.18));
    const c = confluenceFromScore(score);
    return { value, confluence: c, runs: recommendedRuns(score, recent, mode) };
  }

  function renderWaiting(state) {
    const card = state.card;
    card.querySelector(".prediction-timer").innerHTML = `${state.predictionLeft}<span>sec</span>`;
    card.querySelector(".entry-timer").textContent = "—";
    card.querySelector(".trade-now").hidden = true;
  }

  function renderSignal(state, secondsLeft) {
    const card = state.card;
    const signal = state.signal;
    card.querySelector(".prediction-timer").innerHTML = `0<span>sec</span>`;
    card.querySelector(".signal-value").textContent = signal.value;
    const conf = card.querySelector(".confluence");
    conf.textContent = signal.confluence.label;
    conf.className = `confluence ${signal.confluence.level}`;
    card.querySelector(".runs").textContent =
      mode === "evenodd" ? `${signal.runs} Trades` : `${signal.runs} Suggested`;
    card.querySelector(".entry-timer").innerHTML = `${secondsLeft}<span>sec</span>`;
    card.querySelector(".trade-now").hidden = true;
  }

  function renderTradeNow(state) {
    const card = state.card;
    card.querySelector(".entry-timer").textContent = "0";
    card.querySelector(".trade-now").hidden = false;
  }

  function resetCycle(state) {
    state.phase = "prediction";
    state.predictionLeft = PREDICTION_SECONDS;
    state.entryLeft = ENTRY_SECONDS;
    state.tradeNowLeft = TRADE_NOW_SECONDS;
    state.signal = null;
    state.card.querySelector(".signal-value").textContent = "—";
    state.card.querySelector(".confluence").textContent = "WAITING";
    state.card.querySelector(".confluence").className = "confluence";
    state.card.querySelector(".runs").textContent = "—";
    renderWaiting(state);
  }

  function tickState(state) {
    if (state.phase === "prediction") {
      state.predictionLeft -= 1;
      if (state.predictionLeft <= 0) {
        const signal = signalFor(state.digits);
        if (!signal) {
          state.predictionLeft = 3;
          renderWaiting(state);
          return;
        }
        state.signal = signal;
        state.phase = "entry";
        state.entryLeft = ENTRY_SECONDS;
        renderSignal(state, state.entryLeft);
        return;
      }
      renderWaiting(state);
      return;
    }

    if (state.phase === "entry") {
      state.entryLeft -= 1;
      if (state.entryLeft <= 0) {
        state.phase = "trade";
        renderTradeNow(state);
        return;
      }
      renderSignal(state, state.entryLeft);
      return;
    }

    state.tradeNowLeft -= 1;
    if (state.tradeNowLeft <= 0) {
      resetCycle(state);
    }
  }

  async function loadHistory(state) {
    try {
      const response = await fetch(`/api/history?symbol=${encodeURIComponent(state.symbol)}`);
      const data = await response.json();
      if (response.ok && Array.isArray(data.prices)) {
        state.digits = data.prices.map(lastDigit).filter(d => d !== null).slice(-HISTORY_SIZE);
        state.card.querySelector(".card-status").textContent = `${state.digits.length} ticks ready`;
      }
    } catch (error) {
      console.warn("History failed for", state.symbol, error);
      state.card.querySelector(".card-status").textContent = "Waiting for live ticks";
    }
  }

  function updateSummary() {
    const label = document.getElementById("connectionSummary");
    label.textContent = connectedCount === states.size ? "Connected" : `${connectedCount}/${states.size} Connected`;
  }

  function connect(state) {
    const ws = new WebSocket(WS_URL);
    state.ws = ws;

    ws.onopen = async () => {
      connectedCount += 1;
      updateSummary();
      state.card.classList.remove("disconnected");
      state.card.querySelector(".card-status").textContent = "Connected • loading history";
      await loadHistory(state);
      ws.send(JSON.stringify({ ticks: state.symbol, subscribe: 1 }));
    };

    ws.onmessage = event => {
      try {
        const data = JSON.parse(event.data);
        if (data.error) throw new Error(data.error.message || "Deriv API error");
        if (data.msg_type === "tick" && data.tick) {
          const digit = lastDigit(data.tick.quote);
          if (digit !== null) {
            state.digits.push(digit);
            if (state.digits.length > HISTORY_SIZE) state.digits.shift();
            state.card.querySelector(".card-status").textContent = "Live";
          }
        }
      } catch (error) {
        console.warn("Tick error", state.symbol, error);
      }
    };

    ws.onerror = () => {
      state.card.classList.add("disconnected");
      state.card.querySelector(".card-status").textContent = "Connection error";
    };

    ws.onclose = () => {
      state.card.classList.add("disconnected");
      state.card.querySelector(".card-status").textContent = "Disconnected";
      if (connectedCount > 0) connectedCount -= 1;
      updateSummary();
      setTimeout(() => connect(state), 3000);
    };
  }

  function initAuth() {
    fetch("/api/auth/me", { credentials: "include" })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.user?.email) document.getElementById("dashboardUser").textContent = `User: ${data.user.email}`;
      })
      .catch(() => {});
    document.getElementById("dashboardLogout")?.addEventListener("click", async () => {
      try { await fetch("/api/auth/logout", { method: "POST", credentials: "include" }); } catch {}
      location.href = "login.html";
    });
  }

  function initClock() {
    const el = document.getElementById("serverTime");
    setInterval(() => {
      el.textContent = `Server Time: ${new Date().toLocaleTimeString()}`;
    }, 500);
  }

  $all(".market-card").forEach(card => {
    const state = {
      card,
      symbol: card.dataset.symbol,
      digits: [],
      phase: "prediction",
      predictionLeft: PREDICTION_SECONDS,
      entryLeft: ENTRY_SECONDS,
      tradeNowLeft: TRADE_NOW_SECONDS,
      signal: null,
      ws: null
    };
    states.set(state.symbol, state);
    renderWaiting(state);
    connect(state);
  });

  setInterval(() => states.forEach(tickState), 1000);
  initClock();
  initAuth();

  window.addEventListener("beforeunload", () => states.forEach(s => {
    try { s.ws?.close(); } catch {}
  }));
})();

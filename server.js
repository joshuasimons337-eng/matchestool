require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const TronWeb = require("tronweb");
const { WebSocket } = require("ws");
const path = require("path");

const PORT = Number(process.env.PORT || 3000);
const NODE_ENV = process.env.NODE_ENV || "development";
const OWNER_EMAIL = String(process.env.OWNER_EMAIL || "").trim().toLowerCase();
const SESSION_SECRET = process.env.SESSION_SECRET || "";
const TRONGRID_BASE_URL = (process.env.TRONGRID_BASE_URL || "https://api.trongrid.io").replace(/\/$/,"");
const TRONGRID_API_KEY = process.env.TRONGRID_API_KEY || "";
const PAYMENT_ADDRESS = process.env.PAYMENT_ADDRESS || "TA3VbsQJKS5AiMG8gGJaPj8kcfDdBikDao";
const USDT_CONTRACT = process.env.USDT_CONTRACT || "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const USDT_DECIMALS = Number(process.env.USDT_DECIMALS || 6);
const DERIV_WS_URL = "wss://api.derivws.com/trading/v1/options/ws/public";

if (NODE_ENV === "production" && SESSION_SECRET.length < 32) {
  throw new Error("SESSION_SECRET must be at least 32 characters in production.");
}
if (!SESSION_SECRET) console.warn("WARNING: SESSION_SECRET is not set; use .env before production.");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      connectSrc: ["'self'", "wss://api.derivws.com", "https://api.trongrid.io"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));
app.use(express.json({limit:"20kb"}));
app.use(express.urlencoded({extended:false,limit:"20kb"}));

const db = new Database(path.join(__dirname,"data","matchestool.sqlite"));
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions(
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  csrf_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS entitlements(
  user_id INTEGER PRIMARY KEY,
  matches INTEGER NOT NULL DEFAULT 0,
  over_under INTEGER NOT NULL DEFAULT 0,
  full_access INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS payments(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  product TEXT NOT NULL,
  amount_usdt INTEGER NOT NULL,
  tx_hash TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  reason TEXT,
  created_at TEXT NOT NULL,
  verified_at TEXT,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
`);

const authLimiter = rateLimit({windowMs:15*60*1000,max:30,standardHeaders:true,legacyHeaders:false});
const paymentLimiter = rateLimit({windowMs:10*60*1000,max:12,standardHeaders:true,legacyHeaders:false});

function now(){return new Date().toISOString();}
function randomHex(n=32){return crypto.randomBytes(n).toString("hex");}
function hashToken(token){return crypto.createHmac("sha256",SESSION_SECRET || "dev-secret").update(token).digest("hex");}
function hashPassword(password,salt){
  return crypto.scryptSync(password,salt,64,{N:16384,r:8,p:1}).toString("hex");
}
function validEmail(e){return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);}
function validPassword(p){return typeof p==="string" && p.length>=10 && p.length<=200;}
function setSession(res,userId){
  const raw=randomHex(32), csrf=randomHex(24), ttl=7*24*60*60*1000;
  db.prepare("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES(?,?,?,?)")
    .run(hashToken(raw),userId,csrf,Date.now()+ttl);
  res.cookie("dp_session",raw,{httpOnly:true,secure:process.env.COOKIE_SECURE!=="false",sameSite:"lax",maxAge:ttl,path:"/"});
  return csrf;
}
function clearSession(req,res){
  const raw=req.cookies?.dp_session;
  if(raw) db.prepare("DELETE FROM sessions WHERE token_hash=?").run(hashToken(raw));
  res.clearCookie("dp_session",{httpOnly:true,secure:process.env.COOKIE_SECURE!=="false",sameSite:"lax",path:"/"});
}
function getAuth(req){
  const raw=req.headers.cookie?.split(";").map(x=>x.trim()).find(x=>x.startsWith("dp_session="))?.split("=")[1];
  if(!raw) return null;
  const row=db.prepare(`
    SELECT s.user_id,s.csrf_token,s.expires_at,u.email,u.role,e.matches,e.over_under,e.full_access
    FROM sessions s JOIN users u ON u.id=s.user_id
    LEFT JOIN entitlements e ON e.user_id=u.id
    WHERE s.token_hash=?`).get(hashToken(raw));
  if(!row) return null;
  if(row.expires_at<Date.now()){db.prepare("DELETE FROM sessions WHERE token_hash=?").run(hashToken(raw));return null;}
  return row;
}
function requireAuth(req,res,next){const a=getAuth(req);if(!a)return res.status(401).json({error:"Authentication required"});req.auth=a;next();}
function requireCsrf(req,res,next){
  const a=req.auth, supplied=req.get("x-csrf-token") || req.body?.csrfToken;
  const expected=Buffer.from(String(a?.csrf_token||""));
  const actual=Buffer.from(String(supplied||""));
  if(!a || !supplied || expected.length!==actual.length || !crypto.timingSafeEqual(expected,actual))
    return res.status(403).json({error:"CSRF validation failed"});
  next();
}
function productInfo(product){
  const p=String(product||"").toLowerCase();
  if(p==="matches") return {key:"matches",amount:100};
  if(p==="over-under" || p==="over_under" || p==="overunder") return {key:"over_under",amount:100};
  if(p==="full") return {key:"full_access",amount:200};
  return null;
}
function normalizeTx(tx){return String(tx||"").trim().toLowerCase();}
function validTx(tx){return /^[a-f0-9]{64}$/.test(tx);}
function normalizeAddress(addr){
  if(!addr) return "";
  try{
    if(String(addr).startsWith("T")) return String(addr);
    let h=String(addr).replace(/^0x/,"");
    if(h.length===40) h="41"+h;
    return TronWeb.utils.address.fromHex(h);
  }catch{return String(addr);}
}
function decodeAmount(v){
  if(typeof v==="number") return v;
  if(typeof v==="string" && /^\d+$/.test(v)) return Number(v)/10**USDT_DECIMALS;
  if(typeof v==="string" && /^0x[0-9a-f]+$/i.test(v)) return Number(BigInt(v))/10**USDT_DECIMALS;
  return NaN;
}
async function tronFetch(url){
  const headers={"accept":"application/json"};
  if(TRONGRID_API_KEY) headers["TRON-PRO-API-KEY"]=TRONGRID_API_KEY;
  const r=await fetch(url,{headers,signal:AbortSignal.timeout(12000)});
  if(!r.ok) throw new Error(`TronGrid HTTP ${r.status}`);
  return r.json();
}
async function tronPost(url, body){
  const headers={"accept":"application/json","content-type":"application/json"};
  if(TRONGRID_API_KEY) headers["TRON-PRO-API-KEY"]=TRONGRID_API_KEY;
  const r=await fetch(url,{method:"POST",headers,body:JSON.stringify(body),signal:AbortSignal.timeout(12000)});
  if(!r.ok) throw new Error(`TronGrid HTTP ${r.status}`);
  return r.json();
}
async function verifyUsdtPayment(txHash, expectedUsdt){
  if(!validTx(txHash)) return {status:"rejected",reason:"Invalid transaction hash format."};
  if(!TRONGRID_API_KEY && NODE_ENV==="production") return {status:"pending",reason:"TRON verification is not configured yet."};

  try{
    const info=await tronPost(`${TRONGRID_BASE_URL}/walletsolidity/gettransactioninfobyid`,{value:txHash});
    const receipt=String(info?.receipt?.result||"").toUpperCase();
    const contractResults=Array.isArray(info?.contractResult)?info.contractResult:[];
    const contractRet=String(info?.ret?.[0]?.contractRet||"").toUpperCase();
    if(receipt && receipt!=="SUCCESS") return {status:"rejected",reason:"The confirmed transaction did not execute successfully."};
    if(contractRet && contractRet!=="SUCCESS") return {status:"rejected",reason:"The transaction execution result was not successful."};
    if(!info?.blockNumber && !info?.block_number) return {status:"pending",reason:"The transaction is not confirmed yet."};
  }catch(err){
    return {status:"pending",reason:"Unable to confirm the transaction receipt yet; retry later."};
  }

  const eventsUrl=`${TRONGRID_BASE_URL}/v1/transactions/${txHash}/events?only_confirmed=true&limit=200`;
  let events;
  try{events=await tronFetch(eventsUrl);}catch(err){return {status:"pending",reason:"Blockchain verification service unavailable; retry later."};}

  const rows=Array.isArray(events?.data)?events.data:[];
  const matching=rows.find(ev=>{
    const contract=String(ev.contract_address||ev.contractAddress||"");
    const name=String(ev.event_name||ev.eventName||"");
    const result=ev.result||{};
    const to=normalizeAddress(result.to || ev.to);
    const value=decodeAmount(result.value ?? ev.value);
    const contractOk = contract===USDT_CONTRACT || normalizeAddress(contract)===USDT_CONTRACT;
    return name==="Transfer" && contractOk && to===PAYMENT_ADDRESS && Number.isFinite(value) && Math.abs(value-expectedUsdt)<0.000001;
  });
  if(!matching) return {status:"rejected",reason:"No confirmed USDT transfer matching the product amount and receiving address was found."};
  return {status:"verified",reason:"Confirmed USDT transfer matched."};
}

app.get("/api/health",(req,res)=>res.json({ok:true,service:"matchestool",time:now()}));

app.post("/api/auth/register",authLimiter,async(req,res)=>{
  const email=String(req.body.email||"").trim().toLowerCase(), password=req.body.password;
  if(!validEmail(email)||!validPassword(password))return res.status(400).json({error:"Use a valid email and a password of at least 10 characters."});
  const salt=randomHex(16), ph=hashPassword(password,salt);
  try{
    const info=db.prepare("INSERT INTO users(email,password_hash,password_salt,created_at) VALUES(?,?,?,?)").run(email,ph,salt,now());
    db.prepare("INSERT INTO entitlements(user_id) VALUES(?)").run(info.lastInsertRowid);
    const csrf=setSession(res,info.lastInsertRowid);
    res.status(201).json({ok:true,csrf});
  }catch(e){res.status(409).json({error:"An account with that email already exists."});}
});
app.post("/api/auth/login",authLimiter,(req,res)=>{
  const email=String(req.body.email||"").trim().toLowerCase(), password=req.body.password;
  const u=db.prepare("SELECT * FROM users WHERE email=?").get(email);
  if(!u || !validPassword(password) || !crypto.timingSafeEqual(Buffer.from(hashPassword(password,u.password_salt)),Buffer.from(u.password_hash)))
    return res.status(401).json({error:"Invalid email or password."});
  const csrf=setSession(res,u.id); res.json({ok:true,csrf});
});
app.post("/api/auth/logout",(req,res)=>{clearSession(req,res);res.json({ok:true});});
app.get("/api/auth/me",(req,res)=>{
  const a=getAuth(req);
  if(!a)return res.status(401).json({error:"Not authenticated"});

  const isOwner = !!OWNER_EMAIL && a.email === OWNER_EMAIL;

  res.json({
    user:{email:a.email,role:a.role},
    entitlements:{
      matches:isOwner || !!a.matches,
      overUnder:isOwner || !!a.over_under,
      fullAccess:isOwner || !!a.full_access
    },
    csrf:a.csrf_token
  });
});
app.get("/api/history",async(req,res)=>{
  const symbol=String(req.query.symbol||"1HZ100V");

  if(!/^[A-Za-z0-9_]{2,30}$/.test(symbol)){
    return res.status(400).json({error:"Invalid symbol"});
  }

  const ws=new WebSocket(DERIV_WS_URL);

  const timer=setTimeout(()=>{
    try{ws.close()}catch{}
    if(!res.headersSent){
      res.status(504).json({error:"Deriv history request timed out."});
    }
  },10000);

  ws.on("open",()=>{
    ws.send(JSON.stringify({
      ticks_history:symbol,
      end:"latest",
      count:500,
      style:"ticks",
      req_id:1
    }));
  });

  ws.on("message",buf=>{
    clearTimeout(timer);

    try{
      const d=JSON.parse(buf.toString());

      if(d.error){
        if(!res.headersSent){
          res.status(502).json({
            error:d.error.message||"Deriv request failed"
          });
        }
        return ws.close();
      }

      if(d.msg_type==="history"){
        if(!res.headersSent){
          res.json({
            symbol,
            prices:d.history?.prices||[],
            times:d.history?.times||[]
          });
        }
        return ws.close();
      }
    }catch{
      if(!res.headersSent){
        res.status(502).json({
          error:"Invalid response from Deriv"
        });
      }

      try{ws.close()}catch{}
    }
  });

  ws.on("error",()=>{
    clearTimeout(timer);

    if(!res.headersSent){
      res.status(502).json({
        error:"Unable to connect to Deriv public market data."
      });
    }
  });
});
app.post("/api/payments/verify",paymentLimiter,requireAuth,requireCsrf,async(req,res)=>{
  const product=productInfo(req.body.product), txHash=normalizeTx(req.body.txHash);
  if(!product)return res.status(400).json({error:"Invalid product."});
  if(!validTx(txHash))return res.status(400).json({error:"Invalid transaction hash."});
  const existing=db.prepare("SELECT * FROM payments WHERE tx_hash=?").get(txHash);
  if(existing && existing.user_id!==req.auth.user_id)return res.status(409).json({error:"This transaction has already been submitted."});
  if(!existing){
    db.prepare("INSERT INTO payments(user_id,product,amount_usdt,tx_hash,created_at) VALUES(?,?,?,?,?)")
      .run(req.auth.user_id,product.key,product.amount,txHash,now());
  }
  const result=await verifyUsdtPayment(txHash,product.amount);
  db.prepare("UPDATE payments SET status=?,reason=?,verified_at=? WHERE tx_hash=?")
    .run(result.status,result.reason,result.status==="verified"?now():null,txHash);

  if(result.status==="verified"){
    const col=product.key;
    if(col==="full_access"){
      db.prepare("UPDATE entitlements SET full_access=1,matches=1,over_under=1 WHERE user_id=?").run(req.auth.user_id);
    }else{
      db.prepare(`UPDATE entitlements SET ${col}=1 WHERE user_id=?`).run(req.auth.user_id);
    }
    return res.json({ok:true,status:"verified",message:"Payment verified and access activated."});
  }
  res.status(result.status==="pending"?202:400).json({ok:false,status:result.status,message:result.reason});
});

app.get("/api/payments/mine",requireAuth,(req,res)=>{
  const rows=db.prepare("SELECT product,amount_usdt,tx_hash,status,reason,created_at,verified_at FROM payments WHERE user_id=? ORDER BY id DESC").all(req.auth.user_id);
  res.json({payments:rows});
});

app.use(express.static(path.join(__dirname,"public"),{extensions:["html"]}));
app.get("/{*splat}",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));

const server=app.listen(PORT,"0.0.0.0",()=>console.log(`matchestool listening on port ${PORT}`));
process.on("SIGTERM",()=>{server.close(()=>db.close());});
process.on("SIGINT",()=>{server.close(()=>db.close());});

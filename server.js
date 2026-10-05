const express=require("express");
const cors=require("cors");
require("dotenv").config();

const app=express();
app.use(cors());
app.use(express.json());

const PORT=process.env.PORT||3000;
const KEY=process.env.ZEROX_API_KEY;
const VERSION="2.2.0";
const AUTO_SCAN=String(process.env.AUTO_SCAN||"false").toLowerCase()==="true";

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const round=(n,p=6)=>Number.isFinite(Number(n))
  ?Number(Number(n).toFixed(p))
  :0;

const NETWORKS=[
 {
  name:"Base",
  chainId:8453,
  nativeSymbol:"ETH",
  wrappedNative:"WETH",
  tokens:{
   USDC:{
    address:"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    decimals:6
   },
   WETH:{
    address:"0x4200000000000000000000000000000000000006",
    decimals:18
   },
   DAI:{
    address:"0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
    decimals:18
   }
  }
 },
 {
  name:"Arbitrum",
  chainId:42161,
  nativeSymbol:"ETH",
  wrappedNative:"WETH",
  tokens:{
   USDC:{
    address:"0xaf88d065e77c8cc2239327c5edb3a432268e5831",
    decimals:6
   },
   USDT:{
    address:"0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9",
    decimals:6
   },
   WETH:{
    address:"0x82af49447d8a07e3bd95bd0d56f35241523fbab1",
    decimals:18
   },
   ARB:{
    address:"0x912CE59144191C1204E64559FE8253a0e49E6548",
    decimals:18
   }
  }
 },
 {
  name:"Polygon",
  chainId:137,
  nativeSymbol:"POL",
  wrappedNative:"WPOL",
  tokens:{
   USDC:{
    address:"0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    decimals:6
   },
   USDT:{
    address:"0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
    decimals:6
   },
   WPOL:{
    address:"0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    decimals:18
   }
  }
 },
 {
  name:"Optimism",
  chainId:10,
  nativeSymbol:"ETH",
  wrappedNative:"WETH",
  tokens:{
   USDC:{
    address:"0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    decimals:6
   },
   USDT:{
    address:"0x94b008aA00579c1307B0EF2c499aD98a8ce58e58",
    decimals:6
   },
   WETH:{
    address:"0x4200000000000000000000000000000000000006",
    decimals:18
   },
   OP:{
    address:"0x4200000000000000000000000000000000000042",
    decimals:18
   }
  }
 },
 {
  name:"BNB Chain",
  chainId:56,
  nativeSymbol:"BNB",
  wrappedNative:"WBNB",
  tokens:{
   USDC:{
    address:"0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
    decimals:18
   },
   USDT:{
    address:"0x55d398326f99059fF775485246999027B3197955",
    decimals:18
   },
   WBNB:{
    address:"0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    decimals:18
   }
  }
 },
 {
  name:"Ethereum",
  chainId:1,
  nativeSymbol:"ETH",
  wrappedNative:"WETH",
  tokens:{
   USDC:{
    address:"0xA0b86991c6218b36c1d19d4a2e9eb0cE3606eB48",
    decimals:6
   },
   USDT:{
    address:"0xdAC17F958D2ee523a2206206994597C13D831ec7",
    decimals:6
   },
   WETH:{
    address:"0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    decimals:18
   },
   DAI:{
    address:"0x6B175474E89094C44Da98b954EedeAC495271d0F",
    decimals:18
   }
  }
 }
];

const account={
 startingBalance:500,
 balance:500,
 realizedPnL:0,
 simulatedTrades:0,
 wins:0,
 losses:0
};

const tradeHistory=[];
const nativeCache=new Map();

const state={
 running:false,
 cycle:0,
 startedAt:new Date().toISOString(),
 lastScanStarted:null,
 lastScanCompleted:null,
 lastSuccessfulQuote:null,
 rateLimited:false,
 scanPhase:"IDLE",
 currentNetwork:null,
 currentRoute:null,
 routesGenerated:0,
 testsPlanned:0,
 testsAttempted:0,
 testsCompleted:0,
 progressPercent:0,
 candidates:[],
 confirmed:[],
 paperExecuted:[],
 bestTests:[],
 errors:[]
};

function toUnits(a,d){
 const [w,f=""]=Number(a).toFixed(d).split(".");
 return(
  BigInt(w)*10n**BigInt(d)+
  BigInt(f.padEnd(d,"0"))
 ).toString();
}

function fromUnits(v,d){
 if(v==null)return 0;
 const n=BigInt(String(v));
 const q=10n**BigInt(d);
 return Number(n/q)+Number(n%q)/Number(q);
}

function updateProgress(){
 state.progressPercent=state.testsPlanned
  ?Math.min(
    99,
    round(
     state.testsCompleted/state.testsPlanned*100,
     1
    )
   )
  :0;
}

async function price(
 network,
 sell,
 buy,
 amount,
 attempt=1
){
 if(!KEY){
  throw Error("ZEROX_API_KEY is not configured");
 }

 const p=new URLSearchParams({
  chainId:String(network.chainId),
  sellToken:sell.address,
  buyToken:buy.address,
  sellAmount:String(amount),
  slippageBps:"50"
 });

 const r=await fetch(
  "https://api.0x.org/swap/allowance-holder/price?"+p,
  {
   headers:{
    "0x-api-key":KEY,
    "0x-version":"v2"
   }
  }
 );

 if(r.status===429){
  state.rateLimited=true;

  if(attempt>=5){
   throw Error(
    "0x rate limit remained active after retries"
   );
  }

  await sleep(attempt*1800);

  return price(
   network,
   sell,
   buy,
   amount,
   attempt+1
  );
 }

 if(!r.ok){
  throw Error(
   "0x HTTP "+
   r.status+
   ": "+
   (await r.text()).slice(0,240)
  );
 }

 const d=await r.json();

 if(
  d.liquidityAvailable===false||
  !d.buyAmount
 ){
  throw Error(
   "No usable liquidity or price"
  );
 }

 state.lastSuccessfulQuote=
  new Date().toISOString();

 await sleep(240);

 return d;
}

function networkFeeNative(q){
 try{
  const raw=
   q.totalNetworkFee||
   (
    q.gas&&q.gasPrice
     ?(
       BigInt(q.gas)*
       BigInt(q.gasPrice)
      ).toString()
     :"0"
   );

  return fromUnits(raw,18);
 }catch{
  return 0;
 }
}

async function nativeUsd(n){
 const c=nativeCache.get(n.chainId);

 if(
  c&&
  Date.now()-c.at<120000
 ){
  return c.price;
 }

 const w=n.tokens[n.wrappedNative];
 const u=n.tokens.USDC;

 if(!w||!u)return 0;

 try{
  const q=await price(
   n,
   w,
   u,
   toUnits(1,w.decimals)
  );

  const v=fromUnits(
   q.buyAmount,
   u.decimals
  );

  if(v>0){
   nativeCache.set(
    n.chainId,
    {
     price:v,
     at:Date.now()
    }
   );
  }

  return v;
 }catch{
  return c?c.price:0;
 }
}

function fees(q){
 const out=[];

 for(
  const [type,v]
  of Object.entries(q.fees||{})
 ){
  if(!v)continue;

  if(Array.isArray(v)){
   for(const x of v){
    if(
     x&&
     x.amount&&
     x.amount!=="0"
    ){
     out.push({
      type,
      ...x
     });
    }
   }
  }else if(
   v.amount&&
   v.amount!=="0"
  ){
   out.push({
    type,
    ...v
   });
  }
 }

 return out;
}

function routes(n){
 const s=Object.keys(n.tokens);
 const out=[];

 if(!s.includes("USDC")){
  return out;
 }

 for(const a of s){
  if(a!=="USDC"){
   out.push([
    "USDC",
    a,
    "USDC"
   ]);
  }
 }

 for(const a of s){
  if(a==="USDC")continue;

  for(const b of s){
   if(
    b!=="USDC"&&
    b!==a
   ){
    out.push([
     "USDC",
     a,
     b,
     "USDC"
    ]);
   }
  }
 }

 return out;
}

function probeSize(b){
 return b<=25
  ?b
  :Math.max(
    25,
    Math.min(
     100,
     round(b*.10,2)
    )
   );
}

function sizes(b){
 return[
  ...new Set(
   [.05,.10,.20,.35,.50]
    .map(p=>round(b*p,2))
    .concat(
     [
      25,
      50,
      100,
      250,
      500,
      1000,
      2500,
      5000,
      10000
     ].filter(x=>x<=b)
    )
  )
 ]
 .filter(
  x=>x>=10&&x<=b
 )
 .sort((a,c)=>a-c)
 .slice(-7);
}

async function quoteRoute(
 n,
 route,
 tradeSize
){
 let cur=tradeSize;
 let totalNative=0;
 let incomplete=false;

 const legs=[];
 const feeDetails=[];

 for(
  let i=0;
  i<route.length-1;
  i++
 ){
  const a=route[i];
  const b=route[i+1];

  const sell=n.tokens[a];
  const buy=n.tokens[b];

  if(!sell||!buy){
   throw Error(
    "Token missing from network configuration"
   );
  }

  const q=await price(
   n,
   sell,
   buy,
   toUnits(
    cur,
    sell.decimals
   )
  );

  const out=fromUnits(
   q.buyAmount,
   buy.decimals
  );

  const min=q.minBuyAmount
   ?fromUnits(
     q.minBuyAmount,
     buy.decimals
    )
   :out;

  const nf=networkFeeNative(q);

  totalNative+=nf;

  incomplete=
   incomplete||
   Boolean(
    q.issues&&
    q.issues.simulationIncomplete
   );

  feeDetails.push(
   ...fees(q).map(
    x=>({
     leg:i+1,
     ...x
    })
   )
  );

  legs.push({
   leg:i+1,
   from:a,
   to:b,
   amountIn:round(cur,8),
   amountOut:round(out,8),
   minAmountOut:round(min,8),
   networkFeeNative:round(nf,10),
   gas:q.gas||null,
   gasPrice:q.gasPrice||null,
   quotedAt:new Date().toISOString()
  });

  cur=out;
 }

 const np=await nativeUsd(n);

 return{
  finalAmount:cur,
  legs,
  totalNetworkFeeNative:totalNative,
  nativeUsdPrice:np,
  estimatedGasUsd:totalNative*np,
  feeDetails,
  simulationIncomplete:incomplete
 };
}

function risk({
 tradeSize,
 net,
 roi,
 gas,
 gross,
 legs,
 incomplete
}){
 let score=10;
 const reasons=[];

 if(incomplete){
  score+=30;
  reasons.push(
   "quote validation incomplete"
  );
 }

 if(legs>=3){
  score+=10;
  reasons.push(
   "multi-leg triangular route"
  );
 }

 if(roi<.10){
  score+=25;
  reasons.push(
   "thin expected return"
  );
 }else if(roi<.30){
  score+=12;
  reasons.push(
   "modest expected return"
  );
 }

 const share=
  gross>0
   ?gas/gross
   :1;

 if(
  gas>0&&
  share>.5
 ){
  score+=25;
  reasons.push(
   "gas consumes much of gross profit"
  );
 }else if(
  gas>0&&
  share>.25
 ){
  score+=12;
  reasons.push(
   "gas is meaningful versus profit"
  );
 }

 if(
  net<=Math.max(
   .05,
   tradeSize*.0005
  )
 ){
  score+=15;
  reasons.push(
   "small net-profit cushion"
  );
 }

 score=Math.max(
  0,
  Math.min(
   100,
   Math.round(score)
  )
 );

 return{
  score,
  level:
   score<=30
    ?"LOW"
    :score<=60
     ?"MEDIUM"
     :"HIGH",
  reasons:
   reasons.length
    ?reasons
    :[
      "stronger profit cushion under current quote"
     ]
 };
}

function evaluate(
 n,
 route,
 tradeSize,
 q,
 stage="DISCOVERY"
){
 const returned=q.finalAmount;
 const gross=returned-tradeSize;
 const gas=q.estimatedGasUsd||0;
 const net=gross-gas;

 const roi=
  tradeSize
   ?net/tradeSize*100
   :0;

 const r=risk({
  tradeSize,
  net,
  roi,
  gas,
  gross,
  legs:route.length-1,
  incomplete:q.simulationIncomplete
 });

 return{
  id:[
   n.chainId,
   route.join("-"),
   tradeSize,
   Date.now()
  ].join("_"),

  network:n.name,
  chainId:n.chainId,

  route:route.join(" → "),
  routeArray:route,

  routeType:
   route.length===4
    ?"TRIANGULAR"
    :"ROUND_TRIP",

  tradeSize:round(tradeSize,2),
  capitalUsed:round(tradeSize,2),

  estimatedReturn:round(returned),
  expectedFinalValue:round(returned),

  grossProfit:round(gross),

  estimatedGasUsd:round(gas),

  networkFeeNative:
   round(
    q.totalNetworkFeeNative,
    10
   ),

  nativeSymbol:n.nativeSymbol,

  nativeUsdPrice:
   round(
    q.nativeUsdPrice,
    4
   ),

  estimatedNet:round(net),
  roi:round(roi,4),

  riskLevel:r.level,
  riskScore:r.score,
  riskReasons:r.reasons,

  simulationIncomplete:
   Boolean(
    q.simulationIncomplete
   ),

  feeDetails:
   q.feeDetails||[],

  legs:q.legs,

  quoteStatus:stage,

  status:
   net>0
    ?"CANDIDATE"
    :"REJECTED",

  testedAt:
   new Date().toISOString()
 };
}

function publish(x){
 state.bestTests=[
  ...state.bestTests,
  x
 ]
 .sort(
  (a,b)=>
   b.estimatedNet-
   a.estimatedNet
 )
 .slice(0,30);

 if(x.status==="CANDIDATE"){
  state.candidates=[
   ...state.candidates,
   x
  ]
  .sort(
   (a,b)=>
    b.estimatedNet-
    a.estimatedNet
  )
  .slice(0,12);
 }
}

async function test(
 n,
 r,
 s,
 stage
){
 state.currentNetwork=n.name;
 state.currentRoute=r.join(" → ");
 state.testsAttempted++;

 try{
  const x=evaluate(
   n,
   r,
   s,
   await quoteRoute(n,r,s),
   stage
  );

  state.testsCompleted++;
  updateProgress();
  publish(x);

  return x;

 }catch(e){
  state.testsCompleted++;
  updateProgress();

  state.errors.push({
   stage,
   network:n.name,
   route:r.join(" → "),
   tradeSize:s,
   message:e.message
  });

  return null;
 }
}

async function discovery(){
 state.scanPhase="DISCOVERY";

 const all=NETWORKS.flatMap(
  n=>
   routes(n).map(
    r=>({n,r})
   )
 );

 const probe=
  probeSize(account.balance);

 const results=[];

 state.routesGenerated=
  all.length;

 state.testsPlanned=
  all.length;

 for(const x of all){
  const y=await test(
   x.n,
   x.r,
   probe,
   "DISCOVERY"
  );

  if(y){
   results.push(y);
  }
 }

 const ranked=
  results
   .filter(
    x=>
     x.grossProfit>
     -Math.max(
      .10,
      x.tradeSize*.0025
     )
   )
   .sort(
    (a,b)=>
     b.estimatedNet-
     a.estimatedNet
   )
   .slice(0,10);

 const ss=sizes(account.balance);

 state.scanPhase=
  "SIZE_OPTIMIZATION";

 state.testsPlanned+=
  ranked.length*
  ss.length;

 for(const c of ranked){
  const n=NETWORKS.find(
   x=>x.chainId===c.chainId
  );

  for(const s of ss){
   if(
    Math.abs(s-probe)<.001
   ){
    continue;
   }

   const y=await test(
    n,
    c.routeArray,
    s,
    "SIZE_OPTIMIZATION"
   );

   if(y){
    results.push(y);
   }
  }
 }

 return results;
}

async function confirm(c){
 const n=NETWORKS.find(
  x=>x.chainId===c.chainId
 );

 if(!n){
  throw Error(
   "Candidate network not found"
  );
 }

 state.scanPhase=
  "CONFIRMATION";

 state.currentNetwork=
  n.name;

 state.currentRoute=
  c.route;

 await sleep(600);

 const x=evaluate(
  n,
  c.routeArray,
  c.tradeSize,
  await quoteRoute(
   n,
   c.routeArray,
   c.tradeSize
  ),
  "FRESH_REQUOTE"
 );

 x.discoveryNet=
  c.estimatedNet;

 x.discoveryROI=
  c.roi;

 x.confirmedAt=
  new Date().toISOString();

 const min=Math.max(
  .02,
  c.tradeSize*.00025
 );

 const drop=
  c.estimatedNet>0
   ?(
     c.estimatedNet-
     x.estimatedNet
    )/
    c.estimatedNet
   :1;

 if(drop>.25){
  x.riskScore=
   Math.min(
    100,
    x.riskScore+20
   );

  x.riskLevel=
   x.riskScore<=30
    ?"LOW"
    :x.riskScore<=60
     ?"MEDIUM"
     :"HIGH";

  x.riskReasons=[
   ...x.riskReasons,
   "profit weakened materially on fresh re-quote"
  ];
 }

 x.status=
  c.estimatedNet>0&&
  x.estimatedNet>min
   ?"CONFIRMED"
   :"REJECTED_AFTER_REQUOTE";

 return x;
}

async function paperExecute(c){
 const n=NETWORKS.find(
  x=>x.chainId===c.chainId
 );

 if(!n){
  throw Error(
   "Paper execution network not found"
  );
 }

 if(
  c.tradeSize>
  account.balance
 ){
  throw Error(
   "Paper balance is too low for this trade"
  );
 }

 state.scanPhase=
  "PAPER_EXECUTION";

 const x=evaluate(
  n,
  c.routeArray,
  c.tradeSize,
  await quoteRoute(
   n,
   c.routeArray,
   c.tradeSize
  ),
  "PAPER_EXECUTION_QUOTE"
 );

 x.confirmedNet=
  c.estimatedNet;

 x.executedAt=
  new Date().toISOString();

 const min=Math.max(
  .02,
  c.tradeSize*.00025
 );

 if(x.estimatedNet<=min){
  x.status=
   "PAPER_REJECTED";

  return x;
 }

 x.status=
  "PAPER_EXECUTED";

 account.balance=
  round(
   account.balance+
   x.estimatedNet
  );

 account.realizedPnL=
  round(
   account.balance-
   account.startingBalance
  );

 account.simulatedTrades++;

 if(x.estimatedNet>=0){
  account.wins++;
 }else{
  account.losses++;
 }

 tradeHistory.unshift({
  ...x,
  balanceAfter:
   account.balance
 });

 if(tradeHistory.length>200){
  tradeHistory.length=200;
 }

 return x;
}

async function runCycle(){
 if(state.running){
  return false;
 }

 Object.assign(
  state,
  {
   running:true,
   lastScanStarted:
    new Date().toISOString(),
   lastScanCompleted:null,
   rateLimited:false,
   scanPhase:"STARTING",
   currentNetwork:null,
   currentRoute:null,
   routesGenerated:0,
   testsPlanned:0,
   testsAttempted:0,
   testsCompleted:0,
   progressPercent:0,
   candidates:[],
   confirmed:[],
   paperExecuted:[],
   bestTests:[],
   errors:[]
  }
 );

 state.cycle++;

 try{
  const results=
   await discovery();

  results.sort(
   (a,b)=>
    b.estimatedNet-
    a.estimatedNet
  );

  state.bestTests=
   results.slice(0,30);

  const m=new Map();

  for(
   const x of results.filter(
    x=>x.status==="CANDIDATE"
   )
  ){
   const k=
    x.chainId+
    ":"+
    x.route;

   const p=m.get(k);

   if(
    !p||
    x.estimatedNet>
    p.estimatedNet
   ){
    m.set(k,x);
   }
  }

  state.candidates=[
   ...m.values()
  ]
  .sort(
   (a,b)=>
    b.estimatedNet-
    a.estimatedNet
  )
  .slice(0,8);

  const cs=[];

  for(
   const c
   of state.candidates.slice(0,5)
  ){
   try{
    cs.push(
     await confirm(c)
    );
   }catch(e){
    state.errors.push({
     stage:"CONFIRMATION",
     route:c.route,
     message:e.message
    });
   }
  }

  state.confirmed=
   cs
    .filter(
     x=>x.status==="CONFIRMED"
    )
    .sort(
     (a,b)=>
      b.estimatedNet-
      a.estimatedNet
    );

  state.scanPhase=
   "COMPLETE";

  state.progressPercent=100;

  return true;

 }finally{
  state.lastScanCompleted=
   new Date().toISOString();

  state.running=false;

  state.currentNetwork=null;
  state.currentRoute=null;

  if(
   state.scanPhase!=="COMPLETE"
  ){
   state.scanPhase=
    "STOPPED";
  }
 }
}

async function background(){
 if(!AUTO_SCAN){
  return;
 }

 await sleep(5000);

 while(true){
  try{
   await runCycle();
  }catch(e){
   state.errors.push({
    stage:"ENGINE",
    message:e.message
   });

   state.running=false;
  }

  await sleep(300000);
 }
}

app.get(
 "/",
 (req,res)=>
  res.json({
   engine:
    "ArbiFlow Opportunity Engine",
   version:VERSION,
   online:true,
   mode:"paper-trading",
   autoScan:AUTO_SCAN,
   message:
    "Engine 2.2 is online."
  })
);

app.get(
 "/api/status",
 (req,res)=>
  res.json({
   engine:
    "ArbiFlow Opportunity Engine",

   version:VERSION,
   online:true,

   liveProviderConfigured:
    Boolean(KEY),

   provider:
    "0x Swap API",

   running:
    state.running,

   cycle:
    state.cycle,

   startedAt:
    state.startedAt,

   lastScanStarted:
    state.lastScanStarted,

   lastScanCompleted:
    state.lastScanCompleted,

   lastSuccessfulQuote:
    state.lastSuccessfulQuote,

   rateLimited:
    state.rateLimited,

   scanPhase:
    state.scanPhase,

   currentNetwork:
    state.currentNetwork,

   currentRoute:
    state.currentRoute,

   progressPercent:
    state.progressPercent,

   autoScan:
    AUTO_SCAN,

   networks:
    NETWORKS.map(
     n=>({
      name:n.name,
      chainId:n.chainId,
      nativeSymbol:
       n.nativeSymbol,
      tokens:
       Object.keys(n.tokens)
     })
    )
  })
);

app.get(
 "/api/account",
 (req,res)=>
  res.json({
   ...account,

   winRate:
    account.simulatedTrades
     ?round(
       account.wins/
       account.simulatedTrades*
       100,
       2
      )
     :0,

   mode:
    "paper-trading",

   tradeHistory
  })
);

app.post(
 "/api/account/capital",
 (req,res)=>{
  if(state.running){
   return res
    .status(409)
    .json({
     accepted:false,
     message:
      "Wait for the current scan to finish before changing paper capital."
    });
  }

  const a=
   Number(
    req.body&&
    req.body.amount
   );

  if(
   !Number.isFinite(a)||
   a<10||
   a>1000000
  ){
   return res
    .status(400)
    .json({
     accepted:false,
     message:
      "Paper capital must be between $10 and $1,000,000."
    });
  }

  Object.assign(
   account,
   {
    startingBalance:
     round(a,2),

    balance:
     round(a,2),

    realizedPnL:0,
    simulatedTrades:0,
    wins:0,
    losses:0
   }
  );

  tradeHistory.length=0;

  res.json({
   accepted:true,
   message:
    "Paper capital updated.",
   account:{
    ...account
   }
  });
 }
);

app.get(
 "/api/opportunities",
 (req,res)=>
  res.json({
   engine:
    "ArbiFlow Opportunity Engine",

   version:VERSION,
   mode:"paper-trading",

   balance:
    account.balance,

   startingBalance:
    account.startingBalance,

   realizedPnL:
    account.realizedPnL,

   simulatedTrades:
    account.simulatedTrades,

   running:
    state.running,

   cycle:
    state.cycle,

   scanPhase:
    state.scanPhase,

   currentNetwork:
    state.currentNetwork,

   currentRoute:
    state.currentRoute,

   progressPercent:
    state.progressPercent,

   lastScanStarted:
    state.lastScanStarted,

   lastScanCompleted:
    state.lastScanCompleted,

   lastSuccessfulQuote:
    state.lastSuccessfulQuote,

   rateLimited:
    state.rateLimited,

   routesGenerated:
    state.routesGenerated,

   testsPlanned:
    state.testsPlanned,
    .status(409)
    .json({
     accepted:false,
     message:
      "Engine is already scanning."
    });
  }

  runCycle().catch(
   e=>{
    state.errors.push({
     stage:"MANUAL_SCAN",
     message:e.message
    });

    state.running=false;
    state.scanPhase=
     "STOPPED";
   }
  );

  res.json({
   accepted:true,
   message:
    "Engine 2.2 scan started."
  });
 }
);

app.post(
 "/api/paper/execute",
 async(req,res)=>{
  if(state.running){
   return res
    .status(409)
    .json({
     accepted:false,
     message:
      "Wait for the current market scan to finish before paper execution."
    });
  }

  const c=
   state.confirmed.find(
    x=>
     x.id===
     (
      req.body&&
      req.body.id
     )
   );

  if(!c){
   return res
    .status(404)
    .json({
     accepted:false,
     message:
      "Confirmed opportunity not found or no longer current."
    });
  }

  try{
   const x=
    await paperExecute(c);

   state.paperExecuted=[x];

   res.json({
    accepted:
     x.status===
     "PAPER_EXECUTED",

    execution:x,

    account:{
     ...account
    }
   });

  }catch(e){
   res
    .status(500)
    .json({
     accepted:false,
     message:e.message
    });

  }finally{
   state.scanPhase=
    "COMPLETE";
  }
 }
);

app.listen(
 PORT,
 ()=>{
  console.log(
   "ArbiFlow Opportunity Engine "+
   VERSION+
   " running on port "+
   PORT
  );

  console.log(
   "Networks: "+
   NETWORKS
    .map(n=>n.name)
    .join(", ")
  );

  console.log(
   "Automatic scanning: "+
   (
    AUTO_SCAN
     ?"ON"
     :"OFF"
   )
  );

  background().catch(
   e=>
    console.error(
     "Background engine error:",
     e
    )
  );
 }
);

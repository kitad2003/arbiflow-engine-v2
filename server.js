const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ZEROX_API_KEY = process.env.ZEROX_API_KEY;

const VERSION = "2.1.0";
const STARTING_BALANCE = 500;

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));


/* =========================================================
   NETWORKS
========================================================= */
/* =========================================================
   PAPER ACCOUNT
========================================================= */

const account = {
  startingBalance: STARTING_BALANCE,
  balance: STARTING_BALANCE,
  realizedPnL: 0,
  simulatedTrades: 0
};

const tradeHistory = [];


/* =========================================================
   ENGINE STATE
========================================================= */

const state = {
  running: false,
  cycle: 0,

  startedAt: null,
  lastScanStarted: null,
  lastScanCompleted: null,
  lastSuccessfulQuote: null,

  rateLimited: false,

  routesGenerated: 0,
  testsAttempted: 0,
  testsCompleted: 0,

  rejected: [],
  candidates: [],
  confirmed: [],
  paperExecuted: [],
  bestTests: [],

  errors: []
};


/* =========================================================
   UNIT HELPERS
========================================================= */
/* =========================================================
   LIVE 0x PRICE
========================================================= */
    !data.buyAmount
  ) {

    throw new Error(
      "No usable liquidity or price"
    );
  }


  state.lastSuccessfulQuote =
    new Date().toISOString();


  /*
    Slow requests intentionally so the scanner
    does not hammer the quote provider.
  */

  await sleep(1700);

  return data;
}


/* =========================================================
   ROUTE GENERATION
========================================================= */

function generateRoutes(network) {

  const symbols =
    Object.keys(network.tokens);

  const routes = [];


  if (!symbols.includes("USDC")) {

    return routes;
  }


  /*
    ROUND TRIPS

    USDC -> TOKEN -> USDC
  */

  for (const middle of symbols) {

    if (middle === "USDC") {
      continue;
    }

    routes.push([
      "USDC",
      middle,
      "USDC"
    ]);
  }


  /*
    TRIANGULAR ROUTES

    USDC -> TOKEN A -> TOKEN B -> USDC
  */

  for (const first of symbols) {

    if (first === "USDC") {
      continue;
    }


    for (const second of symbols) {

      if (
        second === "USDC" ||
        second === first
      ) {
        continue;
      }


      routes.push([
        "USDC",
        first,
        second,
        "USDC"
      ]);
    }
  }


  return routes;
}


/* =========================================================
   ADAPTIVE POSITION SIZING
========================================================= */

function getPositionSizes(balance) {

  const percentages = [
    0.05,
    0.10,
    0.20,
    0.35,
    0.50
  ];


  const sizes =
    percentages.map(
      (percentage) =>
        Number(
          (
            balance *
            percentage
          ).toFixed(2)
        )
    );


  return [
    ...new Set(sizes)
  ].filter(
    (size) =>
      size >= 10 &&
      size <= balance
  );
}


/* =========================================================
   ROUTE QUOTING
========================================================= */
/* =========================================================
   PROFIT EVALUATION
========================================================= */

function evaluateResult(
  network,
  route,
  tradeSize,
  routeQuote
) {

  const returned =
    routeQuote.finalAmount;


  const grossProfit =
    returned -
    tradeSize;


  /*
    Conservative paper safety reserve.

    IMPORTANT:
    This is not yet true on-chain gas simulation.
/* =========================================================
   DISCOVERY SCAN
========================================================= */
/* =========================================================
   CANDIDATE CONFIRMATION
========================================================= */

async function confirmCandidate(candidate) {

  const network =
    NETWORKS.find(
      (item) =>
        item.chainId ===
        candidate.chainId
    );


  if (!network) {

    throw new Error(
      "Candidate network not found"
    );
  }


  /*
    Wait briefly, then completely re-quote
    the candidate using fresh market prices.
  */

  await sleep(3000);


  const freshQuote =
    await quoteRoute(
      network,
      candidate.routeArray,
      candidate.tradeSize
    );


  const confirmation =
    evaluateResult(
      network,
      candidate.routeArray,
      candidate.tradeSize,
      freshQuote
    );


  confirmation.discoveryNet =
    candidate.estimatedNet;


  confirmation.discoveryROI =
    candidate.roi;


  confirmation.confirmedAt =
    new Date().toISOString();


  const minimumNet =
    Math.max(
      0.02,
      candidate.tradeSize *
        0.00025
    );


  if (
    candidate.estimatedNet > 0 &&
    confirmation.estimatedNet >
      minimumNet
  ) {

    confirmation.status =
      "CONFIRMED";


    confirmation.quoteStatus =
      "FRESH_REQUOTE";


    return confirmation;
  }


  confirmation.status =
    "REJECTED_AFTER_REQUOTE";


  confirmation.quoteStatus =
    "FRESH_REQUOTE";


  return confirmation;
}


/* =========================================================
   PAPER EXECUTION
========================================================= */

async function paperExecute(candidate) {

  const network =
    NETWORKS.find(
      (item) =>
        item.chainId ===
        candidate.chainId
    );


  if (!network) {

    throw new Error(
      "Paper execution network not found"
    );
  }


  /*
    THIRD fresh quote.

    This is paper execution only.

    No wallet.
    No blockchain transaction.
    No real funds.
  */

  await sleep(2500);


  const executionQuote =
    await quoteRoute(
      network,
      candidate.routeArray,
      candidate.tradeSize
    );


  const execution =
    evaluateResult(
      network,
      candidate.routeArray,
      candidate.tradeSize,
      executionQuote
    );


  execution.confirmedNet =
    candidate.estimatedNet;


  execution.executedAt =
    new Date().toISOString();


  execution.quoteStatus =
    "PAPER_EXECUTION_QUOTE";


  const minimumNet =
    Math.max(
      0.02,
      candidate.tradeSize *
        0.00025
    );


  /*
    Opportunity disappeared before
    paper execution.
  */

  if (
    execution.estimatedNet <=
    minimumNet
  ) {

    execution.status =
      "PAPER_REJECTED";


    return execution;
  }


  execution.status =
    "PAPER_EXECUTED";


  /*
    Update the virtual account only after
    the third fresh quote remains profitable.
  */

  account.balance =
    Number(
      (
        account.balance +
        execution.estimatedNet
      ).toFixed(6)
    );


  account.realizedPnL =
    Number(
      (
        account.balance -
        account.startingBalance
      ).toFixed(6)
    );


  account.simulatedTrades += 1;


  const historyEntry = {
    ...execution,

    balanceAfter:
      account.balance
  };


  tradeHistory.unshift(
    historyEntry
  );


  /*
    Prevent unlimited memory growth.
  */

  if (
    tradeHistory.length > 100
  ) {

    tradeHistory.length = 100;
  }


  return execution;
}


/* =========================================================
   FULL ENGINE CYCLE
========================================================= */
      Only strongest candidates advance
      to confirmation.
    state.paperExecuted =
      [];


    /*
      Execute only the strongest confirmed
      candidate in a cycle.

      This avoids double-counting overlapping
      paper opportunities.
    */

    if (
      state.confirmed.length > 0
    ) {

      try {

        const paperResult =
          await paperExecute(
            state.confirmed[0]
          );


        state.paperExecuted =
          [paperResult];

      }

      catch (error) {

        state.errors.push({

          stage:
            "PAPER_EXECUTION",

          message:
            error.message
        });
      }
    }

  }

  finally {

    state.lastScanCompleted =
      new Date().toISOString();


    state.running =
      false;
  }
}


/* =========================================================
   BACKGROUND ENGINE
========================================================= */

async function backgroundLoop() {

  state.startedAt =
    new Date().toISOString();


  /*
    Allow Render to finish starting.
  */

  await sleep(5000);


  while (true) {

    try {

      await runCycle();

    }

    catch (error) {

      state.errors.push({

        stage:
          "ENGINE",

        message:
          error.message
      });


      state.running =
        false;


      state.lastScanCompleted =
        new Date().toISOString();
    }


    /*
      Pause before next full scan.
    */

    await sleep(45000);
  }
}


/* =========================================================
   API
========================================================= */

app.get(
  "/",
  (req, res) => {

    res.json({

      engine:
        "ArbiFlow Opportunity Engine",

      version:
        VERSION,

      online:
        true,

      mode:
        "paper-trading",

      message:
        "Engine 2.1 is online."
        "paper-trading",

      tradeHistory
    });
  }
);


app.get(
  "/api/opportunities",
  (req, res) => {

    res.json({

      engine:
        "ArbiFlow Opportunity Engine",

      version:
        VERSION,

      mode:
        "paper-trading",

      balance:
        account.balance,

      realizedPnL:
        account.realizedPnL,

      simulatedTrades:
        account.simulatedTrades,

      running:
        state.running,

      cycle:
        state.cycle,

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

      testsAttempted:
        state.testsAttempted,

      testsCompleted:
        state.testsCompleted,

      candidatesFound:
        state.candidates.length,

      confirmedFound:
        state.confirmed.length,

      paperExecuted:
        state.paperExecuted,

      /*
        Still intentionally zero.

        Real execution is NOT enabled.
        "Engine 2.1 scan started."
    });
  }
);


/* =========================================================
   START SERVER
========================================================= */

app.listen(
  PORT,
  () => {

    console.log(
      "ArbiFlow Opportunity Engine " +
      VERSION +
      " running on port " +
      PORT
    );


    backgroundLoop()
      .catch(
        (error) => {

          console.error(
            "Background engine error:",
            error
          );
        }
      );
  }
);

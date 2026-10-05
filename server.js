const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ZEROX_API_KEY = process.env.ZEROX_API_KEY;

const VERSION = "2.0.0";
const STARTING_BALANCE = 500;

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/*
========================================================
ARBIFLOW OPPORTUNITY ENGINE 2.0

Development / paper-trading engine.

Stages:
REJECTED
CANDIDATE
CONFIRMED

EXECUTABLE is intentionally disabled until a later
transaction + gas simulation layer is added.
========================================================
*/

const NETWORKS = [
  {
    name: "Base",
    chainId: 8453,

    tokens: {
      USDC: {
        address:
          "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        decimals: 6
      },

      WETH: {
        address:
          "0x4200000000000000000000000000000000000006",
        decimals: 18
      },

      DAI: {
        address:
          "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
        decimals: 18
      }
    }
  },

  {
    name: "Arbitrum",
    chainId: 42161,

    tokens: {
      USDC: {
        address:
          "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
        decimals: 6
      },

      USDT: {
        address:
          "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9",
        decimals: 6
      },

      WETH: {
        address:
          "0x82af49447d8a07e3bd95bd0d56f35241523fbab1",
        decimals: 18
      },

      ARB: {
        address:
          "0x912CE59144191C1204E64559FE8253a0e49E6548",
        decimals: 18
      }
    }
  }
];

const account = {
  startingBalance: STARTING_BALANCE,
  balance: STARTING_BALANCE,
  realizedPnL: 0,
  simulatedTrades: 0
};

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
  bestTests: [],

  errors: []
};


/*
========================================================
UNIT HELPERS
========================================================
*/

function toBaseUnits(amount, decimals) {

  const value =
    Number(amount).toFixed(decimals);

  const [whole, fraction = ""] =
    value.split(".");

  const padded =
    fraction.padEnd(decimals, "0");

  return (
    BigInt(whole) *
      (10n ** BigInt(decimals)) +
    BigInt(padded)
  ).toString();
}


function fromBaseUnits(value, decimals) {

  const amount =
    BigInt(value);

  const divisor =
    10n ** BigInt(decimals);

  const whole =
    amount / divisor;

  const remainder =
    amount % divisor;

  return (
    Number(whole) +
    Number(remainder) /
      Number(divisor)
  );
}


/*
========================================================
LIVE 0x PRICE
========================================================
*/

async function getPrice(
  network,
  sellToken,
  buyToken,
  sellAmount,
  attempt = 1
) {

  const params =
    new URLSearchParams({
      chainId:
        String(network.chainId),

      sellToken:
        sellToken.address,

      buyToken:
        buyToken.address,

      sellAmount:
        String(sellAmount)
    });


  const response =
    await fetch(
      "https://api.0x.org/swap/allowance-holder/price?" +
        params.toString(),
      {
        headers: {
          "0x-api-key":
            ZEROX_API_KEY,

          "0x-version":
            "v2"
        }
      }
    );


  if (response.status === 429) {

    state.rateLimited = true;

    if (attempt >= 4) {

      throw new Error(
        "0x rate limit remained active after retries"
      );
    }

    await sleep(
      attempt * 3500
    );

    return getPrice(
      network,
      sellToken,
      buyToken,
      sellAmount,
      attempt + 1
    );
  }


  if (!response.ok) {

    const body =
      await response.text();

    throw new Error(
      "0x HTTP " +
      response.status +
      ": " +
      body
    );
  }


  const data =
    await response.json();


  if (
    data.liquidityAvailable === false
  ) {

    throw new Error(
      "No liquidity available"
    );
  }


  if (!data.buyAmount) {

    throw new Error(
      "Quote returned no buyAmount"
    );
  }


  state.lastSuccessfulQuote =
    new Date().toISOString();


  /*
  Slow the engine intentionally.

  We want a useful scanner, not one that immediately
  overwhelms the quote provider.
  */

  await sleep(1700);


  return data;
}


/*
========================================================
ROUTE GENERATION
========================================================
*/

function generateRoutes(network) {

  const symbols =
    Object.keys(network.tokens);

  const routes = [];


  /*
  Every route starts and ends in USDC because the
  paper account is denominated in USDC.
  */

  if (!symbols.includes("USDC")) {

    return routes;
  }


  /*
  Two-leg round trips:

  USDC -> X -> USDC
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
  Three-leg triangular paths:

  USDC -> X -> Y -> USDC
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


/*
========================================================
ADAPTIVE POSITION SIZES
========================================================
*/

function getPositionSizes(balance) {

  /*
  Engine tests different percentages of available
  paper capital rather than fixed dollar amounts.
  */

  const percentages = [
    0.05,
    0.10,
    0.20,
    0.35
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


/*
========================================================
ROUTE QUOTING
========================================================
*/

async function quoteRoute(
  network,
  route,
  tradeSize
) {

  let currentAmount =
    tradeSize;

  const legs = [];


  for (
    let index = 0;
    index < route.length - 1;
    index++
  ) {

    const fromSymbol =
      route[index];

    const toSymbol =
      route[index + 1];


    const fromToken =
      network.tokens[fromSymbol];

    const toToken =
      network.tokens[toSymbol];


    if (
      !fromToken ||
      !toToken
    ) {

      throw new Error(
        "Token missing from network configuration"
      );
    }


    const amountIn =
      currentAmount;


    const quote =
      await getPrice(
        network,
        fromToken,
        toToken,
        toBaseUnits(
          amountIn,
          fromToken.decimals
        )
      );


    const amountOut =
      fromBaseUnits(
        quote.buyAmount,
        toToken.decimals
      );


    legs.push({
      from:
        fromSymbol,

      to:
        toSymbol,

      amountIn:
        Number(
          amountIn.toFixed(8)
        ),

      amountOut:
        Number(
          amountOut.toFixed(8)
        ),

      quotedAt:
        new Date().toISOString()
    });


    currentAmount =
      amountOut;


    await sleep(700);
  }


  return {
    finalAmount:
      currentAmount,

    legs
  };
}


/*
========================================================
COST / PROFIT EVALUATION
========================================================
*/

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
  This is deliberately conservative.

  It is NOT yet a true on-chain gas simulation.

  That will be added before anything can ever become
  EXECUTABLE.
  */

  const safetyReserve =
    Math.max(
      0.05,
      tradeSize * 0.002
    );


  const estimatedNet =
    grossProfit -
    safetyReserve;


  const roi =
    (
      estimatedNet /
      tradeSize
    ) * 100;


  return {
    id:
      [
        network.chainId,
        route.join("-"),
        tradeSize,
        Date.now()
      ].join("_"),

    network:
      network.name,

    chainId:
      network.chainId,

    route:
      route.join(" → "),

    routeArray:
      route,

    routeType:
      route.length === 4
        ? "TRIANGULAR"
        : "ROUND_TRIP",

    tradeSize:
      Number(
        tradeSize.toFixed(2)
      ),

    estimatedReturn:
      Number(
        returned.toFixed(6)
      ),

    grossProfit:
      Number(
        grossProfit.toFixed(6)
      ),

    safetyReserve:
      Number(
        safetyReserve.toFixed(6)
      ),

    estimatedNet:
      Number(
        estimatedNet.toFixed(6)
      ),

    roi:
      Number(
        roi.toFixed(4)
      ),

    legs:
      routeQuote.legs,

    quoteStatus:
      "INDICATIVE",

    status:
      estimatedNet > 0
        ? "CANDIDATE"
        : "REJECTED",

    testedAt:
      new Date().toISOString()
  };
}


/*
========================================================
INITIAL DISCOVERY
========================================================
*/

async function discoveryScan() {

  const results = [];

  const sizes =
    getPositionSizes(
      account.balance
    );


  let generated =
    0;

  let attempted =
    0;


  for (
    const network of NETWORKS
  ) {

    const routes =
      generateRoutes(network);


    generated +=
      routes.length;


    for (
      const route of routes
    ) {

      for (
        const tradeSize of sizes
      ) {

        attempted += 1;


        try {

          const routeQuote =
            await quoteRoute(
              network,
              route,
              tradeSize
            );


          const result =
            evaluateResult(
              network,
              route,
              tradeSize,
              routeQuote
            );


          results.push(result);

        } catch (error) {

          state.errors.push({
            stage:
              "DISCOVERY",

            network:
              network.name,

            route:
              route.join(" → "),

            tradeSize,

            message:
              error.message
          });


          await sleep(2500);
        }


        await sleep(1200);
      }
    }
  }


  state.routesGenerated =
    generated;

  state.testsAttempted =
    attempted;


  return results;
}


/*
========================================================
CANDIDATE CONFIRMATION
========================================================
*/

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
  A candidate is re-quoted from the beginning with
  fresh live prices.
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


  /*
  Require both scans to be positive.

  Also require the second result to retain a minimum
  amount of estimated profit.
  */

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


/*
========================================================
FULL ENGINE CYCLE
========================================================
*/

async function runCycle() {

  if (state.running) {

    return;
  }


  state.running =
    true;

  state.cycle +=
    1;

  state.lastScanStarted =
    new Date().toISOString();

  state.rateLimited =
    false;

  state.errors =
    [];


  try {

    const results =
      await discoveryScan();


    results.sort(
      (a, b) =>
        b.estimatedNet -
        a.estimatedNet
    );


    state.testsCompleted =
      results.length;


    state.bestTests =
      results.slice(0, 20);


    state.rejected =
      results
        .filter(
          (item) =>
            item.status ===
            "REJECTED"
        )
        .slice(0, 50);


    /*
    Only strongest initial candidates advance to
    confirmation. This prevents wasting API requests.
    */

    const candidates =
      results
        .filter(
          (item) =>
            item.status ===
            "CANDIDATE"
        )
        .sort(
          (a, b) =>
            b.estimatedNet -
            a.estimatedNet
        )
        .slice(0, 5);


    state.candidates =
      candidates;


    const confirmations =
      [];


    for (
      const candidate
      of candidates
    ) {

      try {

        const confirmed =
          await confirmCandidate(
            candidate
          );


        confirmations.push(
          confirmed
        );

      } catch (error) {

        state.errors.push({
          stage:
            "CONFIRMATION",

          network:
            candidate.network,

          route:
            candidate.route,

          tradeSize:
            candidate.tradeSize,

          message:
            error.message
        });
      }


      await sleep(2500);
    }


    state.confirmed =
      confirmations
        .filter(
          (item) =>
            item.status ===
            "CONFIRMED"
        )
        .sort(
          (a, b) =>
            b.estimatedNet -
            a.estimatedNet
        );


  } finally {

    state.lastScanCompleted =
      new Date().toISOString();

    state.running =
      false;
  }
}


/*
========================================================
BACKGROUND LOOP
========================================================
*/

async function backgroundLoop() {

  state.startedAt =
    new Date().toISOString();


  /*
  Give Render time to finish starting the service.
  */

  await sleep(5000);


  while (true) {

    try {

      await runCycle();

    } catch (error) {

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
    Pause between complete cycles.
    */

    await sleep(45000);
  }
}


/*
========================================================
API
========================================================
*/

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
        "paper-development",

      message:
        "Engine 2.0 is online."
    });
  }
);


app.get(
  "/api/status",
  (req, res) => {

    res.json({
      engine:
        "ArbiFlow Opportunity Engine",

      version:
        VERSION,

      online:
        true,

      liveProviderConfigured:
        Boolean(
          ZEROX_API_KEY
        ),

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

      networks:
        NETWORKS.map(
          (network) => ({
            name:
              network.name,

            chainId:
              network.chainId,

            tokens:
              Object.keys(
                network.tokens
              )
          })
        )
    });
  }
);


app.get(
  "/api/account",
  (req, res) => {

    res.json({
      ...account,

      mode:
        "paper-development"
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
        "paper-development",

      balance:
        account.balance,

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

      /*
      Intentionally zero.

      Confirmation is NOT equivalent to safe,
      transaction-simulated executability.
      */

      executableOpportunities:
        0,

      candidates:
        state.candidates,

      confirmed:
        state.confirmed,

      bestTests:
        state.bestTests,

      errors:
        state.errors
    });
  }
);


app.post(
  "/api/scan/start",
  (req, res) => {

    if (state.running) {

      return res.json({
        accepted:
          false,

        message:
          "Engine is already scanning."
      });
    }


    runCycle()
      .catch(
        (error) => {

          state.errors.push({
            stage:
              "MANUAL_SCAN",

            message:
              error.message
          });
        }
      );


    return res.json({
      accepted:
        true,

      message:
        "Engine 2.0 scan started."
    });
  }
);


/*
========================================================
START
========================================================
*/

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

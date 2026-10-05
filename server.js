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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const NETWORKS = [
  {
    name: "Base",
    chainId: 8453,
    tokens: {
      USDC: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
      WETH: { address: "0x4200000000000000000000000000000000000006", decimals: 18 },
      DAI: { address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", decimals: 18 }
    }
  },
  {
    name: "Arbitrum",
    chainId: 42161,
    tokens: {
      USDC: { address: "0xaf88d065e77c8cc2239327c5edb3a432268e5831", decimals: 6 },
      USDT: { address: "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", decimals: 6 },
      WETH: { address: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1", decimals: 18 },
      ARB: { address: "0x912CE59144191C1204E64559FE8253a0e49E6548", decimals: 18 }
    }
  }
];

const account = {
  startingBalance: STARTING_BALANCE,
  balance: STARTING_BALANCE,
  realizedPnL: 0,
  simulatedTrades: 0
};

const tradeHistory = [];

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

function toBaseUnits(amount, decimals) {
  const value = Number(amount).toFixed(decimals);
  const parts = value.split(".");
  const whole = parts[0];
  const fraction = parts[1] || "";
  return (
    BigInt(whole) * (10n ** BigInt(decimals)) +
    BigInt(fraction.padEnd(decimals, "0"))
  ).toString();
}

function fromBaseUnits(value, decimals) {
  const amount = BigInt(value);
  const divisor = 10n ** BigInt(decimals);
  return Number(amount / divisor) + Number(amount % divisor) / Number(divisor);
}

async function getPrice(network, sellToken, buyToken, sellAmount, attempt = 1) {
  const params = new URLSearchParams({
    chainId: String(network.chainId),
    sellToken: sellToken.address,
    buyToken: buyToken.address,
    sellAmount: String(sellAmount)
  });

  const response = await fetch(
    "https://api.0x.org/swap/allowance-holder/price?" + params.toString(),
    {
      headers: {
        "0x-api-key": ZEROX_API_KEY,
        "0x-version": "v2"
      }
    }
  );

  if (response.status === 429) {
    state.rateLimited = true;

    if (attempt >= 4) {
      throw new Error("0x rate limit remained active after retries");
    }

    await sleep(attempt * 3500);

    return getPrice(
      network,
      sellToken,
      buyToken,
      sellAmount,
      attempt + 1
    );
  }

  if (!response.ok) {
    throw new Error(
      "0x HTTP " +
      response.status +
      ": " +
      await response.text()
    );
  }

  const data = await response.json();

  if (data.liquidityAvailable === false || !data.buyAmount) {
    throw new Error("No usable liquidity or price");
  }

  state.lastSuccessfulQuote = new Date().toISOString();

  await sleep(1700);

  return data;
}

function generateRoutes(network) {
  const symbols = Object.keys(network.tokens);
  const routes = [];

  if (!symbols.includes("USDC")) {
    return routes;
  }

  for (const middle of symbols) {
    if (middle !== "USDC") {
      routes.push(["USDC", middle, "USDC"]);
    }
  }

  for (const first of symbols) {
    if (first === "USDC") continue;

    for (const second of symbols) {
      if (second === "USDC" || second === first) continue;

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

function getPositionSizes(balance) {
  return [
    ...new Set(
      [0.05, 0.10, 0.20, 0.35, 0.50].map(
        (percentage) =>
          Number((balance * percentage).toFixed(2))
      )
    )
  ].filter(
    (size) =>
      size >= 10 &&
      size <= balance
  );
}

async function quoteRoute(network, route, tradeSize) {
  let currentAmount = tradeSize;
  const legs = [];

  for (let index = 0; index < route.length - 1; index++) {
function evaluateResult(network, route, tradeSize, routeQuote) {
  const returned = routeQuote.finalAmount;
  const grossProfit = returned - tradeSize;

  const safetyReserve = Math.max(
    0.05,
    tradeSize * 0.002
  );

  const estimatedNet =
    grossProfit - safetyReserve;

  const roi =
    (estimatedNet / tradeSize) * 100;

  return {
    id: [
      network.chainId,
      route.join("-"),
      tradeSize,
      Date.now()
    ].join("_"),

    network: network.name,
    chainId: network.chainId,
    route: route.join(" → "),
    routeArray: route,

    routeType:
      route.length === 4
        ? "TRIANGULAR"
        : "ROUND_TRIP",

    tradeSize: Number(tradeSize.toFixed(2)),
    estimatedReturn: Number(returned.toFixed(6)),
    grossProfit: Number(grossProfit.toFixed(6)),
    safetyReserve: Number(safetyReserve.toFixed(6)),
    estimatedNet: Number(estimatedNet.toFixed(6)),
    roi: Number(roi.toFixed(4)),

    legs: routeQuote.legs,
    quoteStatus: "INDICATIVE",

    status:
      estimatedNet > 0
        ? "CANDIDATE"
        : "REJECTED",

    testedAt: new Date().toISOString()
  };
}

async function discoveryScan() {
  const results = [];
  const sizes = getPositionSizes(account.balance);

  let generated = 0;
  let attempted = 0;

  for (const network of NETWORKS) {
    const routes = generateRoutes(network);

    generated += routes.length;

    for (const route of routes) {
      for (const tradeSize of sizes) {
        attempted += 1;

        try {
          const routeQuote = await quoteRoute(
            network,
            route,
            tradeSize
          );

          results.push(
            evaluateResult(
              network,
              route,
              tradeSize,
              routeQuote
            )
          );
        } catch (error) {
          state.errors.push({
            stage: "DISCOVERY",
            network: network.name,
            route: route.join(" → "),
            tradeSize: tradeSize,
            message: error.message
          });

          await sleep(2500);
        }

        await sleep(1200);
      }
    }
  }

  state.routesGenerated = generated;
  state.testsAttempted = attempted;

  return results;
}

async function confirmCandidate(candidate) {
  const network = NETWORKS.find(
    (item) =>
      item.chainId === candidate.chainId
  );

  if (!network) {
    throw new Error("Candidate network not found");
  }

async function paperExecute(candidate) {
  const network = NETWORKS.find(
    (item) =>
      item.chainId === candidate.chainId
  );

  if (!network) {
    throw new Error("Paper execution network not found");
  }

  tradeHistory.unshift({
    ...execution,
    balanceAfter: account.balance
  });

  if (tradeHistory.length > 100) {
    tradeHistory.length = 100;
  }

  return execution;
}

async function runCycle() {
  if (state.running) return;

  state.running = true;
  state.cycle += 1;
  state.lastScanStarted = new Date().toISOString();
  state.rateLimited = false;
  state.errors = [];

  try {
    const results = await discoveryScan();

    results.sort(
      (a, b) =>
        b.estimatedNet -
        a.estimatedNet
    );

    state.testsCompleted = results.length;
    state.bestTests = results.slice(0, 20);

    state.rejected = results
      .filter(
        (item) =>
          item.status === "REJECTED"
      )
      .slice(0, 50);

    state.candidates = results
      .filter(
        (item) =>
          item.status === "CANDIDATE"
      )
      .sort(
        (a, b) =>
          b.estimatedNet -
          a.estimatedNet
      )
      .slice(0, 5);

    const confirmations = [];

    for (const candidate of state.candidates) {
      try {
        confirmations.push(
          await confirmCandidate(candidate)
        );
      } catch (error) {
        state.errors.push({
          stage: "CONFIRMATION",
          message: error.message
        });
      }

      await sleep(2500);
    }

    state.confirmed = confirmations
      .filter(
        (item) =>
          item.status === "CONFIRMED"
      )
      .sort(
        (a, b) =>
          b.estimatedNet -
          a.estimatedNet
      );

    state.paperExecuted = [];

    if (state.confirmed.length > 0) {
      try {
        const paperResult =
          await paperExecute(
            state.confirmed[0]
          );

        state.paperExecuted =
          [paperResult];
      } catch (error) {
        state.errors.push({
          stage: "PAPER_EXECUTION",
          message: error.message
        });
      }
    }
  } finally {
    state.lastScanCompleted =
      new Date().toISOString();

    state.running = false;
  }
}

async function backgroundLoop() {
  state.startedAt =
    new Date().toISOString();

  await sleep(5000);

  while (true) {
    try {
      await runCycle();
    } catch (error) {
      state.errors.push({
        stage: "ENGINE",
        message: error.message
      });

      state.running = false;
    }

    await sleep(45000);
app.listen(PORT, () => {
  console.log(
    "ArbiFlow Opportunity Engine " +
    VERSION +
    " running on port " +
    PORT
  );

  backgroundLoop().catch(
    (error) => {
      console.error(
        "Background engine error:",
        error
      );
    }
  );
});

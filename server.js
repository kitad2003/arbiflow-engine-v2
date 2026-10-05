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
   NETWORK CONFIGURATION
  const parts = value.split(".");
  const whole = parts[0];
  const fraction = parts[1] || "";

  const padded =
    fraction.padEnd(decimals, "0");

  const multiplier =
    10n ** BigInt(decimals);

  return (
    BigInt(whole) * multiplier +
  const url =
    "https://api.0x.org/swap/allowance-holder/price?" +
    params.toString();

  const response =
    await fetch(url, {
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
    ROUND TRIP
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
    TRIANGULAR
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

    legs:
      legs
  };
}

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
    Conservative paper reserve.

    This is NOT yet true on-chain
    transaction/gas simulation.
    for (const route of routes) {
      for (const tradeSize of sizes) {
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
            stage: "DISCOVERY",
            network: network.name,
            route:
              route.join(" → "),
            tradeSize:
    Fresh second quote.
    PAPER ONLY.
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

      Maximum one paper execution
      per scan cycle.
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
      } catch (error) {
        state.errors.push({
          stage:
            "PAPER_EXECUTION",

          message:
            error.message
        });
      }
    }
  } finally {
    state.lastScanCompleted =
      new Date().toISOString();

    state.running =
      false;
  }
}

/* =========================================================
   BACKGROUND LOOP
========================================================= */

async function backgroundLoop() {
  state.startedAt =
    new Date().toISOString();

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

      tradeHistory:
        REAL execution remains disabled.
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

    backgroundLoop().catch(
      (error) => {
        console.error(
          "Background engine error:",
          error
        );
      }
    );
  }
);

On Oct 5, 2026, at 7:37 AM, k_2003 Dan <kitad2012@gmail.com> wrote:

﻿
const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ZEROX_API_KEY = process.env.ZEROX_API_KEY;

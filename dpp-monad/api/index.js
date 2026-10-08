require("dotenv").config();

const express = require("express");
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const proof = require("../sdk/proof");

const app = express();

app.use(express.json());


// ======================================================
// CONFIGURATION
// ======================================================

const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;

const ML_LOG_FILE = path.join(
  __dirname,
  "..",
  "..",
  "Monad_hackathon",
  "logs",
  "inference.jsonl"
);

// Structured source of truth for accepted AI events.
// (inference.jsonl above is now audit-only for the API.)
const SQLITE_FILE =
  process.env.SQLITE_FILE
    ? path.resolve(__dirname, process.env.SQLITE_FILE)
    : path.join(
        __dirname,
        "..",
        "..",
        "Monad_hackathon",
        "sqlite",
        "donation_box.db"
      );


// ======================================================
// ORIGINAL RECORD REGISTRY
// ======================================================
//
// This file is automatically maintained by the API.
//
// It stores the ORIGINAL accepted record at the moment
// it is successfully registered on Monad.
//
// We NEVER manually edit this file.
//

const DATA_DIR = path.join(__dirname, "data");

const ORIGINAL_RECORDS_FILE =
  path.join(DATA_DIR, "original_records.json");


// Create data directory if it does not exist
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}


// Create registry file if it does not exist
if (!fs.existsSync(ORIGINAL_RECORDS_FILE)) {
  fs.writeFileSync(
    ORIGINAL_RECORDS_FILE,
    JSON.stringify([], null, 2),
    "utf8"
  );
}


// ======================================================
// SMART CONTRACT ABI
// ======================================================

const CONTRACT_ABI = [

  "function registerProof(bytes32 _proofHash, string calldata _sourceId) external",

  "function verifyProof(bytes32 _proofHash) external view returns (bool exists, string memory sourceId, uint256 timestamp, address registeredBy)"

];


// ======================================================
// BLOCKCHAIN CONNECTION
// ======================================================

const provider =
  new ethers.JsonRpcProvider(RPC_URL);

const wallet =
  new ethers.Wallet(
    PRIVATE_KEY,
    provider
  );

const contract =
  new ethers.Contract(
    CONTRACT_ADDRESS,
    CONTRACT_ABI,
    wallet
  );


// ======================================================
// CORS
// ======================================================

app.use((req, res, next) => {

  res.header(
    "Access-Control-Allow-Origin",
    "*"
  );

  res.header(
    "Access-Control-Allow-Methods",
    "GET,POST,OPTIONS"
  );

  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );

  next();

});


// ======================================================
// CREATE LEGACY RAW-RECORD HASH
// ======================================================
//
// Hash of the raw ML record (JSONL-shaped). Every proof
// registered BEFORE canonical AI events used this, and
// blockchain.py still sends it as a lookup key.
//
// The algorithm lives in the SDK so the canonical event's
// recordHash and this function can never drift apart.
//

function createProofHash(record) {

  return proof.hashLegacyRecord(record);

}


// ======================================================
// READ DONATIONS FROM SQLITE (PRIMARY SOURCE OF TRUTH)
// ======================================================
//
// Monad_hackathon/sqlite/donation_box.db is the structured
// source for accepted AI events. inference.jsonl stays as the
// audit stream written by live_camera.py; the API no longer
// reads it.
//
// Every row is returned as:
//
//   lineNumber : donations.id (name kept so the dashboard's
//                "recordNumber" keeps working)
//   donation   : the raw SQLite row
//   record     : legacy JSONL-shaped record rebuilt from the
//                row (dashboard compatibility + legacy hash)
//

function openDonationDatabase() {

  if (!fs.existsSync(SQLITE_FILE)) {

    throw new Error(
      `SQLite database not found: ${SQLITE_FILE}`
    );

  }

  return new Database(
    SQLITE_FILE,
    {
      readonly: true,
      fileMustExist: true,
      timeout: 5000
    }
  );

}


function toDonationItem(donation) {

  return {

    lineNumber:
      donation.id,

    donation,

    record:
      proof.donationToLegacyRecord(
        donation
      )

  };

}


function getAllDonationRecords() {

  const db =
    openDonationDatabase();

  try {

    return db
      .prepare(
        "SELECT * FROM donations ORDER BY id ASC"
      )
      .all()
      .map(toDonationItem);

  } finally {

    db.close();

  }

}


function getLatestDonationRecord() {

  const db =
    openDonationDatabase();

  try {

    const row =
      db
        .prepare(
          "SELECT * FROM donations ORDER BY id DESC LIMIT 1"
        )
        .get();

    if (!row) {

      throw new Error(
        "SQLite donations table is empty"
      );

    }

    return toDonationItem(row);

  } finally {

    db.close();

  }

}


function getDonationById(donationId) {

  const db =
    openDonationDatabase();

  try {

    const row =
      db
        .prepare(
          "SELECT * FROM donations WHERE donation_id = ?"
        )
        .get(donationId);

    return row
      ? toDonationItem(row)
      : null;

  } finally {

    db.close();

  }

}


// ======================================================
// ORIGINAL RECORD REGISTRY FUNCTIONS
// ======================================================

function readOriginalRecords() {

  try {

    if (!fs.existsSync(ORIGINAL_RECORDS_FILE)) {
      return [];
    }

    const content =
      fs.readFileSync(
        ORIGINAL_RECORDS_FILE,
        "utf8"
      );

    if (!content.trim()) {
      return [];
    }

    const records =
      JSON.parse(content);

    if (!Array.isArray(records)) {
      return [];
    }

    return records;

  } catch (error) {

    console.error(
      "Error reading original records:",
      error.message
    );

    return [];

  }

}


function writeOriginalRecords(records) {

  fs.writeFileSync(
    ORIGINAL_RECORDS_FILE,
    JSON.stringify(
      records,
      null,
      2
    ),
    "utf8"
  );

}


// ======================================================
// CREATE STABLE RECORD ID
// ======================================================
//
// The hash changes if the record is tampered with.
//
// Therefore we CANNOT use the hash as the identity
// when detecting tampering.
//
// Instead we use:
// sourceId + original timestamp
//
// Example:
// webcam-0|2026-10-07T04:05:25.210977+00:00
//

function createRecordId(record) {

  return `${record.pocket_id || "unknown"}|${record.timestamp || "unknown"}`;

}


// ======================================================
// FIND DONATION FOR REGISTRATION
// ======================================================
//
// Resolves the SQLite row a /register-proof request refers to.
//
//   1. donationId  (exact, preferred: sent by blockchain.py)
//   2. proofHash   (legacy raw-record hash, old clients)
//

function findDonationForRegistration({
  donationId,
  proofHash
}) {

  if (donationId) {

    const item =
      getDonationById(
        donationId
      );

    if (item) {

      return item;

    }

  }

  if (proofHash) {

    const wanted =
      proofHash.toLowerCase();

    for (
      const item of getAllDonationRecords()
    ) {

      if (
        createProofHash(
          item.record
        ).toLowerCase() === wanted
      ) {

        return item;

      }

    }

  }

  return null;

}


// ======================================================
// SAVE ORIGINAL RECORD
// ======================================================

function saveOriginalRecord(record, proofHash, blockchainInfo, proofInfo) {

  const records =
    readOriginalRecords();

  const recordId =
    createRecordId(record);

  // Prevent duplicate snapshots
  const existingIndex =
    records.findIndex(
      item =>
        item.recordId === recordId
    );

  const snapshot = {

    recordId,

    proofHash,

    // Which hashing scheme proofHash used, and the frozen
    // provenance (issuer/device/model/modelHash) at registration
    // time. Verification re-uses it so a later model swap or config
    // change cannot make an untouched record look tampered.
    proofScheme:
      proofInfo?.proofScheme || proof.PROOF_SCHEME_LEGACY,

    legacyProofHash:
      proofInfo?.legacyProofHash || null,

    provenance:
      proofInfo?.provenance || null,

    canonicalEvent:
      proofInfo?.canonicalEvent || null,

    sourceId:
      record.pocket_id || "unknown",

    originalDenomination:
      record.predicted_denomination || null,

    originalBin:
      record.target_bin || null,

    originalRecord:
      record,

    registeredAt:
      new Date().toISOString(),

    transactionHash:
      blockchainInfo?.transactionHash || null,

    blockNumber:
      blockchainInfo?.blockNumber || null

  };


  if (existingIndex >= 0) {

    // Never replace an existing original
    console.log(
      "Original snapshot already exists:",
      recordId
    );

    return records[existingIndex];

  }


  records.push(snapshot);

  writeOriginalRecords(records);

  console.log();
  console.log(
    "=== ORIGINAL RECORD SAVED ==="
  );

  console.log(
    "Record ID:",
    recordId
  );

  console.log(
    "Original denomination:",
    snapshot.originalDenomination
  );

  console.log(
    "Original bin:",
    snapshot.originalBin
  );

  console.log(
    "Original proof hash:",
    proofHash
  );

  return snapshot;

}


// ======================================================
// FIND ORIGINAL SNAPSHOT
// ======================================================

function findOriginalSnapshot(record) {

  const records =
    readOriginalRecords();

  const recordId =
    createRecordId(record);

  return (
    records.find(
      item =>
        item.recordId === recordId
    ) || null
  );

}


// ======================================================
// FIND TRANSACTION FOR PROOF
// ======================================================

async function findProofTransaction(
  proofHash
) {

  try {

    const latestBlock =
      await provider.getBlockNumber();

    const fromBlock =
      Math.max(
        0,
        latestBlock - 200000
      );

    const eventTopic =
      ethers.id(
        "ProofRegistered(bytes32,string,uint256,address)"
      );

    const logs =
      await provider.getLogs({

        address:
          CONTRACT_ADDRESS,

        topics: [
          eventTopic,
          proofHash
        ],

        fromBlock,

        toBlock:
          latestBlock

      });

    if (logs.length === 0) {

      return null;

    }

    const latestMatchingLog =
      logs[logs.length - 1];

    return {

      transactionHash:
        latestMatchingLog.transactionHash,

      blockNumber:
        latestMatchingLog.blockNumber,

      explorerUrl:
        `https://testnet.monadexplorer.com/tx/${latestMatchingLog.transactionHash}`

    };

  } catch (error) {

    console.error(
      "Transaction lookup error:",
      error.message
    );

    return null;

  }

}


// ======================================================
// VERIFY A DONATION ON-CHAIN (CANONICAL + LEGACY)
// ======================================================
//
// Two hashes can represent one SQLite row:
//
//   canonical : SHA-256 of the canonical AI event (new)
//   legacy    : SHA-256 of the raw ML record     (old)
//
// New registrations use canonical. Proofs already on Monad
// from before this change used legacy, so we try canonical
// first and fall back to legacy. If neither exists on-chain
// the caller decides NOT_REGISTERED vs TAMPERED exactly as
// before.
//
// Provenance for the canonical event comes from the original
// snapshot (frozen at registration). Rows with no snapshot use
// the current config + current model file hash.
//

let canonicalUnavailableWarned = false;


function buildProofCandidates(item, originalSnapshot) {

  const legacyHash =
    createProofHash(
      item.record
    );

  let canonicalEvent = null;

  let canonicalHash = null;

  try {

    const provenance =
      originalSnapshot?.provenance ||
      proof.getCurrentProvenance();

    canonicalEvent =
      proof.createCanonicalAIEvent(
        item.donation,
        provenance
      );

    canonicalHash =
      proof.hashAIEvent(
        canonicalEvent
      );

  } catch (error) {

    if (!canonicalUnavailableWarned) {

      canonicalUnavailableWarned = true;

      console.warn(
        "Canonical proof unavailable, using legacy hash only:",
        error.message
      );

    }

  }

  return {

    legacyHash,

    canonicalEvent,

    canonicalHash

  };

}


async function verifyDonationOnChain(
  item,
  originalSnapshot
) {

  const {
    legacyHash,
    canonicalEvent,
    canonicalHash
  } = buildProofCandidates(
    item,
    originalSnapshot
  );


  let canonicalResult = null;

  if (canonicalHash) {

    canonicalResult =
      await contract.verifyProof(
        canonicalHash
      );

    if (canonicalResult[0]) {

      return {

        exists: true,

        proofHash: canonicalHash,

        proofScheme:
          proof.PROOF_SCHEME_CANONICAL,

        blockchainResult:
          canonicalResult,

        canonicalEvent,

        legacyHash

      };

    }

  }


  const legacyResult =
    await contract.verifyProof(
      legacyHash
    );

  if (legacyResult[0]) {

    return {

      exists: true,

      proofHash: legacyHash,

      proofScheme:
        proof.PROOF_SCHEME_LEGACY,

      blockchainResult:
        legacyResult,

      canonicalEvent,

      legacyHash

    };

  }


  // Not on-chain under either hash.
  // Report the preferred (canonical) CURRENT hash.
  return {

    exists: false,

    proofHash:
      canonicalHash || legacyHash,

    proofScheme:
      canonicalHash
        ? proof.PROOF_SCHEME_CANONICAL
        : proof.PROOF_SCHEME_LEGACY,

    blockchainResult:
      canonicalResult || legacyResult,

    canonicalEvent,

    legacyHash

  };

}


// ======================================================
// HOME
// ======================================================

app.get("/", (req, res) => {

  res.json({

    service:
      "DaanDristi Blockchain API",

    status:
      "running",

    originalRegistry:
      ORIGINAL_RECORDS_FILE,

    donationDatabase:
      SQLITE_FILE

  });

});


// ======================================================
// REGISTER BLOCKCHAIN PROOF
// ======================================================
//
// Accepts:
//   { donationId, sourceId }            (blockchain.py, preferred)
//   { proofHash,  sourceId }            (legacy clients)
//   { donationId, proofHash, sourceId } (blockchain.py sends both)
//
// When the SQLite row is found, the hash registered on Monad is
// the CANONICAL AI event hash, not the raw-record hash the client
// sent. The response `proofHash` is the hash actually registered.
//
// When the row cannot be found, behavior falls back to the old
// flow: register the client-supplied hash as-is.
//

app.post(
  "/register-proof",
  async (req, res) => {

    try {

      const {
        proofHash,
        sourceId,
        donationId
      } = req.body;


      if (
        !sourceId ||
        (!proofHash && !donationId)
      ) {

        return res.status(400).json({

          success:
            false,

          error:
            "sourceId and either proofHash or donationId are required"

        });

      }


      console.log();

      console.log(
        "=========================================="
      );

      console.log(
        "REGISTERING BLOCKCHAIN PROOF"
      );

      console.log(
        "=========================================="
      );

      console.log(
        "Client proof hash:",
        proofHash || "(none)"
      );

      console.log(
        "Donation ID:",
        donationId || "(none)"
      );

      console.log(
        "Source ID:",
        sourceId
      );


      // ------------------------------------------------
      // Find the exact SQLite row for this request
      // ------------------------------------------------

      const item =
        findDonationForRegistration({
          donationId,
          proofHash
        });


      let registerHash;

      let proofScheme;

      let provenance = null;

      let canonicalEvent = null;

      let legacyProofHash =
        proofHash || null;


      if (item) {

        // Throws if the model file cannot be read:
        // we never register a fake modelHash.
        provenance =
          proof.getCurrentProvenance();

        canonicalEvent =
          proof.createCanonicalAIEvent(
            item.donation,
            provenance
          );

        registerHash =
          proof.hashAIEvent(
            canonicalEvent
          );

        proofScheme =
          proof.PROOF_SCHEME_CANONICAL;

        legacyProofHash =
          createProofHash(
            item.record
          );

        console.log(
          "Event ID:",
          canonicalEvent.eventId
        );

        console.log(
          "Canonical proof hash:",
          registerHash
        );

      } else {

        if (!proofHash) {

          return res.status(404).json({

            success:
              false,

            error:
              "donationId not found in SQLite database"

          });

        }

        console.warn(
          "WARNING: Could not find matching SQLite record."
        );

        console.warn(
          "Registering the client-supplied hash as-is."
        );

        registerHash =
          proofHash;

        proofScheme =
          proof.PROOF_SCHEME_LEGACY;

      }


      // ------------------------------------------------
      // Send transaction to Monad
      // ------------------------------------------------

      const tx =
        await contract.registerProof(
          registerHash,
          sourceId
        );

      console.log(
        "Transaction sent:",
        tx.hash
      );


      // ------------------------------------------------
      // Wait for confirmation
      // ------------------------------------------------

      const receipt =
        await tx.wait();

      console.log(
        "Transaction confirmed!"
      );

      console.log(
        "Block:",
        receipt.blockNumber
      );


      const explorerUrl =
        `https://testnet.monadexplorer.com/tx/${tx.hash}`;


      // ------------------------------------------------
      // AUTOMATICALLY SAVE ORIGINAL SNAPSHOT
      // ------------------------------------------------

      if (item) {

        saveOriginalRecord(
          item.record,
          registerHash,
          {
            transactionHash:
              tx.hash,

            blockNumber:
              receipt.blockNumber
          },
          {
            proofScheme,

            legacyProofHash,

            provenance,

            canonicalEvent
          }
        );

      }


      res.json({

        success:
          true,

        transactionHash:
          tx.hash,

        blockNumber:
          receipt.blockNumber,

        explorerUrl,

        proofHash:
          registerHash,

        proofScheme,

        legacyProofHash,

        eventId:
          canonicalEvent?.eventId || null,

        sourceId

      });


    } catch (error) {

      console.error(
        "Blockchain registration error:",
        error
      );

      res.status(500).json({

        success:
          false,

        error:
          error.message

      });

    }

  }
);


// ======================================================
// VERIFY BLOCKCHAIN PROOF
// ======================================================

app.get(
  "/verify-proof/:hash",
  async (req, res) => {

    try {

      const proofHash =
        req.params.hash;


      if (!proofHash) {

        return res.status(400).json({

          success:
            false,

          error:
            "Proof hash is required"

        });

      }


      console.log();

      console.log(
        "=== VERIFYING BLOCKCHAIN PROOF ==="
      );

      console.log(
        "Proof Hash:",
        proofHash
      );


      const result =
        await contract.verifyProof(
          proofHash
        );


      let transactionInfo =
        null;


      if (result[0]) {

        transactionInfo =
          await findProofTransaction(
            proofHash
          );

      }


      res.json({

        success:
          true,

        exists:
          result[0],

        sourceId:
          result[1],

        timestamp:
          result[2].toString(),

        registeredBy:
          result[3],

        transactionHash:
          transactionInfo?.transactionHash ||
          null,

        blockNumber:
          transactionInfo?.blockNumber ||
          null,

        explorerUrl:
          transactionInfo?.explorerUrl ||
          null

      });


    } catch (error) {

      console.error(
        "Blockchain verification error:",
        error
      );

      res.status(500).json({

        success:
          false,

        error:
          error.message

      });

    }

  }
);


// ======================================================
// GET LATEST ACCEPTED RECORD (SQLITE)
// ======================================================

app.get(
  "/latest-record",
  async (req, res) => {

    try {

      const item =
        getLatestDonationRecord();

      const record =
        item.record;


      if (
        record.decision !==
        "ACCEPT"
      ) {

        return res.json({

          success:
            true,

          record,

          blockchain: {

            exists:
              false,

            message:
              "Blockchain proof skipped because decision is not ACCEPT."

          }

        });

      }


      const originalSnapshot =
        findOriginalSnapshot(
          record
        );


      const verification =
        await verifyDonationOnChain(
          item,
          originalSnapshot
        );

      const proofHash =
        verification.proofHash;

      const blockchainResult =
        verification.blockchainResult;


      let transactionInfo =
        null;


      if (
        blockchainResult[0]
      ) {

        transactionInfo =
          await findProofTransaction(
            proofHash
          );

      }


      let status;

      if (blockchainResult[0]) {

        status =
          "VERIFIED";

      } else if (originalSnapshot) {

        status =
          "TAMPERED";

      } else {

        status =
          "NOT_REGISTERED";

      }


      res.json({

        success:
          true,

        record,

        // Canonical AI provenance event for this row
        event:
          verification.canonicalEvent,

        blockchain: {

          proofHash,

          proofScheme:
            verification.proofScheme,

          exists:
            blockchainResult[0],

          status,

          sourceId:
            blockchainResult[1],

          timestamp:
            blockchainResult[2].toString(),

          registeredBy:
            blockchainResult[3],

          transactionHash:
            transactionInfo?.transactionHash ||
            null,

          blockNumber:
            transactionInfo?.blockNumber ||
            null,

          explorerUrl:
            transactionInfo?.explorerUrl ||
            null

        },

        original: originalSnapshot
          ? {

              denomination:
                originalSnapshot.originalDenomination,

              bin:
                originalSnapshot.originalBin,

              proofHash:
                originalSnapshot.proofHash

            }
          : null

      });


    } catch (error) {

      console.error(
        "Latest record error:",
        error
      );

      res.status(500).json({

        success:
          false,

        error:
          error.message

      });

    }

  }
);


// ======================================================
// ⭐ VERIFY ALL ACCEPTED RECORDS
// ======================================================

// ------------------------------------------------------
// Console summary de-duplication
// ------------------------------------------------------
//
// /all-records is polled repeatedly by the dashboard.
// The verification itself still runs on every request,
// but the console summary is only printed the first time
// and whenever Total / Verified / Tampered / Not registered
// changes.
//

let lastPrintedSummaryKey = null;

function printVerificationSummaryIfChanged(
  total,
  verified,
  tampered,
  notRegistered
) {

  const summaryKey =
    `${total}|${verified}|${tampered}|${notRegistered}`;

  if (summaryKey === lastPrintedSummaryKey) {
    return;
  }

  lastPrintedSummaryKey = summaryKey;

  console.log();

  console.log(
    "=========================================="
  );

  console.log(
    "VERIFYING ALL DONATION RECORDS"
  );

  console.log(
    "=========================================="
  );

  console.log(
    "Total:",
    total
  );

  console.log(
    "Verified:",
    verified
  );

  console.log(
    "Tampered:",
    tampered
  );

  console.log(
    "Not registered:",
    notRegistered
  );

}


app.get(
  "/all-records",
  async (req, res) => {

    try {

      const allRecords =
        getAllDonationRecords();


      const results = [];


      for (
        const item of allRecords
      ) {

        const record =
          item.record;


        // Only ACCEPT records
        if (
          record.decision !==
          "ACCEPT"
        ) {

          continue;

        }


        // ----------------------------------------------
        // Find original snapshot (holds frozen provenance)
        // ----------------------------------------------

        const originalSnapshot =
          findOriginalSnapshot(
            record
          );


        // ----------------------------------------------
        // Ask Monad whether the CURRENT canonical proof
        // hash exists. Falls back to the legacy raw-record
        // hash for proofs registered before canonical events.
        // ----------------------------------------------

        const verification =
          await verifyDonationOnChain(
            item,
            originalSnapshot
          );

        const currentHash =
          verification.proofHash;

        const blockchainResult =
          verification.blockchainResult;

        const exists =
          verification.exists;


        // ----------------------------------------------
        // Determine status
        // ----------------------------------------------

        let status;

        if (exists) {

          status =
            "VERIFIED";

        } else if (originalSnapshot) {

          status =
            "TAMPERED";

        } else {

          status =
            "NOT_REGISTERED";

        }


        // ----------------------------------------------
        // Compare original/current values
        // ----------------------------------------------

        const currentDenomination =
          record.predicted_denomination ||
          null;

        const currentBin =
          record.target_bin ||
          null;


        const originalDenomination =
          originalSnapshot
            ?.originalDenomination ||
          null;

        const originalBin =
          originalSnapshot
            ?.originalBin ||
          null;


        let tamperDetails =
          null;


        if (
          status ===
          "TAMPERED"
        ) {

          const changes = [];


          if (
            originalDenomination !==
            currentDenomination
          ) {

            changes.push(
              `Denomination changed from ₹${originalDenomination} to ₹${currentDenomination}`
            );

          }


          if (
            originalBin !==
            currentBin
          ) {

            changes.push(
              `Bin changed from ${originalBin} to ${currentBin}`
            );

          }


          if (
            changes.length === 0
          ) {

            changes.push(
              "Record contents changed and the current hash no longer matches the blockchain proof."
            );

          }


          tamperDetails =
            changes.join(
              " | "
            );

        }


        // ----------------------------------------------
        // Build result
        // ----------------------------------------------

        results.push({

          recordNumber:
            item.lineNumber,

          record,

          status,

          exists,

          proofHash:
            currentHash,

          proofScheme:
            verification.proofScheme,

          eventId:
            item.donation.donation_id,


          // Original information
          originalDenomination,

          originalBin,

          originalProofHash:
            originalSnapshot?.proofHash ||
            null,


          // Current information
          currentDenomination,

          currentBin,


          // Human-readable explanation
          tamperDetails,


          // Blockchain information
          sourceId:
            blockchainResult[1],

          timestamp:
            blockchainResult[2].toString(),

          registeredBy:
            blockchainResult[3],

          transactionHash:
            originalSnapshot?.transactionHash ||
            null,

          blockNumber:
            originalSnapshot?.blockNumber ||
            null,

          explorerUrl:
            originalSnapshot?.transactionHash
              ? `https://testnet.monadexplorer.com/tx/${originalSnapshot.transactionHash}`
              : null

        });

      }


      // =================================================
      // COUNTS
      // =================================================

      const verifiedRecords =
        results.filter(
          item =>
            item.status ===
            "VERIFIED"
        ).length;


      const tamperedRecords =
        results.filter(
          item =>
            item.status ===
            "TAMPERED"
        ).length;


      const notRegisteredRecords =
        results.filter(
          item =>
            item.status ===
            "NOT_REGISTERED"
        ).length;


      printVerificationSummaryIfChanged(
        results.length,
        verifiedRecords,
        tamperedRecords,
        notRegisteredRecords
      );


      res.json({

        success:
          true,

        totalRecords:
          results.length,

        verifiedRecords,

        tamperedRecords,

        notRegisteredRecords,

        records:
          results

      });


    } catch (error) {

      console.error(
        "All records verification error:",
        error
      );

      res.status(500).json({

        success:
          false,

        error:
          error.message

      });

    }

  }
);


// ======================================================
// ORIGINAL REGISTRY VIEW
// ======================================================
//
// Useful for debugging/demo.
// Shows what the API automatically preserved.
//

app.get(
  "/original-records",
  (req, res) => {

    try {

      const records =
        readOriginalRecords();

      res.json({

        success:
          true,

        count:
          records.length,

        records

      });

    } catch (error) {

      res.status(500).json({

        success:
          false,

        error:
          error.message

      });

    }

  }
);


// ======================================================
// START SERVER
// ======================================================

const PORT = 3000;

app.listen(
  PORT,
  () => {

    console.log();

    console.log(
      "=========================================="
    );

    console.log(
      "DaanDristi Blockchain API"
    );

    console.log(
      "=========================================="
    );

    console.log(
      `API running on http://localhost:${PORT}`
    );

    console.log(
      "Wallet:",
      wallet.address
    );

    console.log(
      "Contract:",
      CONTRACT_ADDRESS
    );

    console.log(
      "SQLite (source of truth):",
      SQLITE_FILE
    );

    console.log(
      "ML Log (audit only):",
      ML_LOG_FILE
    );

    try {

      const provenance =
        proof.getCurrentProvenance();

      console.log(
        "Issuer:",
        provenance.issuer
      );

      console.log(
        "Device ID:",
        provenance.deviceId
      );

      console.log(
        "Model ID:",
        provenance.modelId
      );

      console.log(
        "Model hash:",
        provenance.modelHash
      );

    } catch (error) {

      console.warn(
        "Provenance unavailable:",
        error.message
      );

    }

    console.log(
      "Original Registry:",
      ORIGINAL_RECORDS_FILE
    );

    console.log(
      "=========================================="
    );

    console.log();

  }
);
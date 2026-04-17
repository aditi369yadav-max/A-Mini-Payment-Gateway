-- ============================================================
-- UPI Gateway — State Machine in Haskell
--
-- This module implements the payment state machine as pure
-- Haskell functions. No IO, no side effects — just types
-- and transformations.
--
-- This is what Juspay's entire backend looks like at scale.
-- Even this small module demonstrates:
--   1. ADT for domain modelling
--   2. Maybe/Either for error handling (no exceptions)
--   3. Pattern matching for exhaustive case handling
--   4. Pure functions with referential transparency
--
-- Compile:  ghc -o state_machine StateMachine.hs
-- Run:      ./state_machine
-- ============================================================

module StateMachine where

import Data.Maybe (fromMaybe, mapMaybe)
import Data.List  (intercalate)

-- ============================================================
-- Domain Types — Algebraic Data Types (ADTs)
-- The compiler enforces exhaustive pattern matching.
-- You CANNOT forget a state. Haskell won't compile if you do.
-- ============================================================

data TransactionStatus
  = Initiated
  | Authenticated
  | Processing
  | Success
  | Failed
  | Reconciled
  deriving (Show, Eq, Ord, Enum, Bounded)

-- Either-like result type
data TransitionResult
  = TransitionOk   TransactionStatus
  | TransitionErr  TransitionError
  deriving (Show)

data TransitionError
  = InvalidTransition TransactionStatus TransactionStatus
  | TerminalState     TransactionStatus
  deriving (Show)

-- ============================================================
-- Transition Table — pure data, not imperative logic
-- Pattern matching is exhaustive — compiler checks all cases
-- ============================================================

validTransitions :: TransactionStatus -> [TransactionStatus]
validTransitions Initiated     = [Authenticated, Failed]
validTransitions Authenticated = [Processing,    Failed]
validTransitions Processing    = [Success,        Failed]
validTransitions Success       = [Reconciled]
validTransitions Failed        = [Initiated]   -- retry path
validTransitions Reconciled    = []            -- terminal

-- ============================================================
-- Pure: check if a state is terminal
-- ============================================================

isTerminal :: TransactionStatus -> Bool
isTerminal Reconciled = True
isTerminal _          = False

-- ============================================================
-- Pure: validate a state transition
-- Returns Either-style result — no exceptions
-- ============================================================

validateTransition
  :: TransactionStatus
  -> TransactionStatus
  -> TransitionResult
validateTransition from to
  | isTerminal from               = TransitionErr (TerminalState from)
  | to `elem` validTransitions from = TransitionOk to
  | otherwise                     = TransitionErr (InvalidTransition from to)

-- ============================================================
-- Pure: compute exponential backoff delay in milliseconds
-- Uses integer arithmetic only — no floating point needed
-- ============================================================

computeBackoffMs
  :: Int    -- attempt number (0-indexed)
  -> Int    -- base delay ms
  -> Int    -- max delay ms
  -> Int
computeBackoffMs attempt baseMs maxMs =
  min (baseMs * (2 ^ attempt)) maxMs

-- ============================================================
-- Pure: classify a mismatch between two status values
-- (Used in reconciliation engine)
-- ============================================================

data MismatchType
  = StatusMismatch TransactionStatus TransactionStatus
  | NoMismatch
  deriving (Show, Eq)

classifyMismatch
  :: TransactionStatus  -- source of truth (our DB)
  -> TransactionStatus  -- external source (bank/NPCI)
  -> MismatchType
classifyMismatch expected actual
  | expected == actual = NoMismatch
  | otherwise          = StatusMismatch expected actual

-- ============================================================
-- Pure: get all states reachable from a starting state
-- Breadth-first traversal — useful for testing coverage
-- ============================================================

reachableStates :: TransactionStatus -> [TransactionStatus]
reachableStates start = go [start] []
  where
    go []     visited = visited
    go (s:ss) visited
      | s `elem` visited = go ss visited
      | otherwise        = go (ss ++ validTransitions s) (visited ++ [s])

-- ============================================================
-- Pure: validate a full transition sequence
-- Useful for testing that a sequence of states is valid
-- ============================================================

validateSequence :: [TransactionStatus] -> Either TransitionError [TransactionStatus]
validateSequence []  = Right []
validateSequence [x] = Right [x]
validateSequence (x:y:rest) =
  case validateTransition x y of
    TransitionErr e -> Left e
    TransitionOk  _ -> fmap (x:) (validateSequence (y:rest))

-- ============================================================
-- Show helpers
-- ============================================================

showStatus :: TransactionStatus -> String
showStatus Initiated     = "INITIATED"
showStatus Authenticated = "AUTHENTICATED"
showStatus Processing    = "PROCESSING"
showStatus Success       = "SUCCESS"
showStatus Failed        = "FAILED"
showStatus Reconciled    = "RECONCILED"

showError :: TransitionError -> String
showError (InvalidTransition f t) =
  "Invalid transition: " ++ showStatus f ++ " -> " ++ showStatus t
showError (TerminalState s) =
  "Terminal state: " ++ showStatus s ++ " (no further transitions allowed)"

-- ============================================================
-- Main: demonstrate all functionality
-- ============================================================

main :: IO ()
main = do
  putStrLn "\n============================================"
  putStrLn "  UPI Gateway — Haskell State Machine Demo"
  putStrLn "============================================\n"

  -- 1. Valid happy path
  putStrLn "[ Happy Path: INITIATED -> AUTHENTICATED -> PROCESSING -> SUCCESS -> RECONCILED ]"
  let happyPath = [Initiated, Authenticated, Processing, Success, Reconciled]
  case validateSequence happyPath of
    Right states -> putStrLn $ "  ✓ Valid: " ++ intercalate " -> " (map showStatus states)
    Left  err    -> putStrLn $ "  ✗ Error: " ++ showError err

  -- 2. Retry path
  putStrLn "\n[ Retry Path: INITIATED -> AUTHENTICATED -> PROCESSING -> FAILED -> INITIATED ]"
  let retryPath = [Initiated, Authenticated, Processing, Failed, Initiated]
  case validateSequence retryPath of
    Right states -> putStrLn $ "  ✓ Valid: " ++ intercalate " -> " (map showStatus states)
    Left  err    -> putStrLn $ "  ✗ Error: " ++ showError err

  -- 3. Invalid jump
  putStrLn "\n[ Invalid: INITIATED -> SUCCESS (skipping states) ]"
  case validateTransition Initiated Success of
    TransitionOk  _ -> putStrLn "  ✓ Allowed (unexpected!)"
    TransitionErr e -> putStrLn $ "  ✗ Blocked: " ++ showError e

  -- 4. Terminal state
  putStrLn "\n[ Terminal: RECONCILED -> anything ]"
  case validateTransition Reconciled Initiated of
    TransitionOk  _ -> putStrLn "  ✓ Allowed (unexpected!)"
    TransitionErr e -> putStrLn $ "  ✗ Blocked: " ++ showError e

  -- 5. Backoff delays
  putStrLn "\n[ Exponential Backoff (base=1000ms, max=30000ms) ]"
  let delays = map (\n -> (n, computeBackoffMs n 1000 30000)) [0..5]
  mapM_ (\(n, d) -> putStrLn $ "  Attempt " ++ show (n+1) ++ ": " ++ show d ++ "ms") delays

  -- 6. Reachable states
  putStrLn "\n[ States reachable from INITIATED ]"
  let reachable = reachableStates Initiated
  putStrLn $ "  " ++ intercalate ", " (map showStatus reachable)

  -- 7. Mismatch detection
  putStrLn "\n[ Mismatch Detection ]"
  let m1 = classifyMismatch Success Processing
  let m2 = classifyMismatch Success Success
  putStrLn $ "  Success vs Processing: " ++ show m1
  putStrLn $ "  Success vs Success:    " ++ show m2

  putStrLn "\n============================================\n"

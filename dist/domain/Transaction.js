"use strict";
// ============================================================
// Domain Models — Pure data types, zero side effects
//
// Senior engineer principle: Domain models should be values,
// not objects. They carry data and can be transformed via pure
// functions. Nothing in this file touches DB, Redis, or HTTP.
// ============================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.updateTransaction = void 0;
// ============================================================
// Pure helper: create an immutable update of a transaction
// Never mutate — always return a new object
// ============================================================
const updateTransaction = (txn, updates) => Object.freeze({ ...txn, ...updates, updatedAt: new Date() });
exports.updateTransaction = updateTransaction;
//# sourceMappingURL=Transaction.js.map
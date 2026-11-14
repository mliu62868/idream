CREATE TABLE "chat_turn_edit_receipts" (
    "turnId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,

    CONSTRAINT "chat_turn_edit_receipts_pkey" PRIMARY KEY ("turnId", "idempotencyKey"),
    CONSTRAINT "chat_turn_edit_receipts_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "chat_turns"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

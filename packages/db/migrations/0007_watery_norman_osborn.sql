ALTER TABLE "finance"."journal_entries" ADD COLUMN "created_txid" bigint DEFAULT txid_current() NOT NULL;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION finance.trg_fn_journal_lines_same_tx()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_created_txid bigint;
BEGIN
  SELECT created_txid
  INTO v_created_txid
  FROM finance.journal_entries
  WHERE id = NEW.entry_id;

  IF v_created_txid IS NULL THEN
    RAISE EXCEPTION 'Journal entry % does not exist', NEW.entry_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_created_txid <> txid_current() THEN
    RAISE EXCEPTION 'Cannot append journal lines to committed entry % in a later transaction', NEW.entry_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER trg_journal_lines_same_tx
BEFORE INSERT ON finance.journal_lines
FOR EACH ROW
EXECUTE FUNCTION finance.trg_fn_journal_lines_same_tx();
--> statement-breakpoint
CREATE TRIGGER trg_journal_entries_no_truncate
BEFORE TRUNCATE ON finance.journal_entries
FOR EACH STATEMENT
EXECUTE FUNCTION finance.trg_fn_prevent_ledger_mutation();
--> statement-breakpoint
CREATE TRIGGER trg_journal_lines_no_truncate
BEFORE TRUNCATE ON finance.journal_lines
FOR EACH STATEMENT
EXECUTE FUNCTION finance.trg_fn_prevent_ledger_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION finance.trg_fn_accounts_immutable_type_currency()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.currency IS DISTINCT FROM OLD.currency THEN
    RAISE EXCEPTION 'finance.accounts.currency is immutable (account %: % -> %)', OLD.id, OLD.currency, NEW.currency
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.type IS DISTINCT FROM OLD.type THEN
    RAISE EXCEPTION 'finance.accounts.type is immutable (account %: % -> %)', OLD.id, OLD.type, NEW.type
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER trg_accounts_immutable_type_currency
BEFORE UPDATE ON finance.accounts
FOR EACH ROW
EXECUTE FUNCTION finance.trg_fn_accounts_immutable_type_currency();

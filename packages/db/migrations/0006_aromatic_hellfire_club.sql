CREATE SCHEMA "finance";
--> statement-breakpoint
CREATE TABLE "finance"."accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"currency" char(3) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_code_unique" UNIQUE("code"),
	CONSTRAINT "accounts_type_check" CHECK (type IN ('asset', 'liability', 'equity', 'revenue', 'expense'))
);
--> statement-breakpoint
CREATE TABLE "finance"."journal_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"effective_date" date NOT NULL,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"description" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"entry_kind" text NOT NULL,
	"reverses_entry_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_entries_source_unique" UNIQUE("source_type","source_id","entry_kind"),
	CONSTRAINT "journal_entries_reverses_unique" UNIQUE("reverses_entry_id")
);
--> statement-breakpoint
CREATE TABLE "finance"."journal_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"entry_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"currency" char(3) NOT NULL,
	"debit_minor" bigint DEFAULT 0 NOT NULL,
	"credit_minor" bigint DEFAULT 0 NOT NULL,
	"memo" text,
	CONSTRAINT "journal_lines_debit_non_negative" CHECK (debit_minor >= 0),
	CONSTRAINT "journal_lines_credit_non_negative" CHECK (credit_minor >= 0),
	CONSTRAINT "journal_lines_one_side_positive" CHECK ((debit_minor > 0) <> (credit_minor > 0))
);
--> statement-breakpoint
ALTER TABLE "finance"."accounts" ADD CONSTRAINT "accounts_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "reference"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."journal_entries" ADD CONSTRAINT "journal_entries_reverses_entry_id_journal_entries_id_fk" FOREIGN KEY ("reverses_entry_id") REFERENCES "finance"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."journal_lines" ADD CONSTRAINT "journal_lines_entry_id_journal_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "finance"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."journal_lines" ADD CONSTRAINT "journal_lines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "finance"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."journal_lines" ADD CONSTRAINT "journal_lines_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "reference"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "journal_lines_entry_id_idx" ON "finance"."journal_lines" USING btree ("entry_id");--> statement-breakpoint
CREATE INDEX "journal_lines_account_id_idx" ON "finance"."journal_lines" USING btree ("account_id");

--> statement-breakpoint
CREATE OR REPLACE FUNCTION finance.check_journal_entry_balanced(p_entry_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_line_count integer;
  v_currency char(3);
  v_debit numeric;
  v_credit numeric;
BEGIN
  SELECT COUNT(*)
  INTO v_line_count
  FROM finance.journal_lines
  WHERE entry_id = p_entry_id;

  IF v_line_count < 2 THEN
    RAISE EXCEPTION 'Journal entry % must have at least 2 lines (found %)', p_entry_id, v_line_count
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT currency, SUM(debit_minor), SUM(credit_minor)
  INTO v_currency, v_debit, v_credit
  FROM finance.journal_lines
  WHERE entry_id = p_entry_id
  GROUP BY currency
  HAVING SUM(debit_minor) <> SUM(credit_minor)
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'Journal entry % is unbalanced for currency %: debit=% credit=%',
      p_entry_id, v_currency, v_debit, v_credit
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION finance.trg_fn_journal_lines_balanced()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM finance.check_journal_entry_balanced(NEW.entry_id);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION finance.trg_fn_journal_entries_balanced()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM finance.check_journal_entry_balanced(NEW.id);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_journal_lines_balanced
AFTER INSERT ON finance.journal_lines
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION finance.trg_fn_journal_lines_balanced();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_journal_entries_balanced
AFTER INSERT ON finance.journal_entries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION finance.trg_fn_journal_entries_balanced();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION finance.trg_fn_journal_lines_currency_match()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_account_currency char(3);
BEGIN
  SELECT currency
  INTO v_account_currency
  FROM finance.accounts
  WHERE id = NEW.account_id;

  IF v_account_currency IS NULL THEN
    RAISE EXCEPTION 'Account % does not exist', NEW.account_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_account_currency IS DISTINCT FROM NEW.currency THEN
    RAISE EXCEPTION 'Journal line currency % does not match account % currency %',
      NEW.currency, NEW.account_id, v_account_currency
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER trg_journal_lines_currency_match
BEFORE INSERT ON finance.journal_lines
FOR EACH ROW
EXECUTE FUNCTION finance.trg_fn_journal_lines_currency_match();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION finance.trg_fn_prevent_ledger_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '%.% is immutable; corrections must be posted as reversals', TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER trg_journal_entries_immutable
BEFORE UPDATE OR DELETE ON finance.journal_entries
FOR EACH ROW
EXECUTE FUNCTION finance.trg_fn_prevent_ledger_mutation();
--> statement-breakpoint
CREATE TRIGGER trg_journal_lines_immutable
BEFORE UPDATE OR DELETE ON finance.journal_lines
FOR EACH ROW
EXECUTE FUNCTION finance.trg_fn_prevent_ledger_mutation();

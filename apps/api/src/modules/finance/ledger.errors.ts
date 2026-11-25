export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class LedgerValidationError extends LedgerError {}

export class LedgerUnbalancedError extends LedgerError {
  constructor(
    readonly currency: string,
    readonly debitMinor: bigint,
    readonly creditMinor: bigint,
  ) {
    super(
      `Journal entry is unbalanced for currency ${currency}: debit=${debitMinor.toString()} credit=${creditMinor.toString()}`,
    );
  }
}

export class LedgerAccountNotFoundError extends LedgerError {
  constructor(readonly accountId: string) {
    super(`Ledger account not found: ${accountId}`);
  }
}

export class LedgerAccountInactiveError extends LedgerError {
  constructor(readonly accountId: string) {
    super(`Ledger account is inactive: ${accountId}`);
  }
}

export class LedgerCurrencyMismatchError extends LedgerError {
  constructor(
    readonly accountId: string,
    readonly accountCurrency: string,
    readonly lineCurrency: string,
  ) {
    super(
      `Line currency ${lineCurrency} does not match account ${accountId} currency ${accountCurrency}`,
    );
  }
}

export class LedgerConflictError extends LedgerError {
  constructor(
    readonly sourceType: string,
    readonly sourceId: string,
    readonly entryKind: string,
  ) {
    super(
      `Journal entry conflict for (${sourceType}, ${sourceId}, ${entryKind}): existing entry has different lines`,
    );
  }
}

export class LedgerAlreadyReversedError extends LedgerError {
  constructor(readonly entryId: string) {
    super(`Journal entry ${entryId} has already been reversed`);
  }
}

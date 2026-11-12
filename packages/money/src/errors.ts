export class UnsupportedCurrencyError extends Error {
  constructor(currency: string) {
    super(`Unsupported currency code: ${currency}`);
    this.name = 'UnsupportedCurrencyError';
  }
}

export class CurrencyMismatchError extends Error {
  constructor(expected: string, actual: string) {
    super(`Currency mismatch: expected ${expected}, got ${actual}`);
    this.name = 'CurrencyMismatchError';
  }
}

export class InvalidMoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMoneyError';
  }
}

export class InvalidRateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRateError';
  }
}

export class EmptyListError extends Error {
  constructor(message = 'Operation requires at least one element or an explicit currency') {
    super(message);
    this.name = 'EmptyListError';
  }
}

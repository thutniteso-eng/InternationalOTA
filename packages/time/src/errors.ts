export class InvalidDateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidDateError';
  }
}

export class InvalidTimeZoneError extends Error {
  constructor(tz: string) {
    super(`Invalid IANA time zone: "${tz}"`);
    this.name = 'InvalidTimeZoneError';
  }
}

export class InvalidDateRangeError extends Error {
  constructor(message = 'checkOut must not be before checkIn') {
    super(message);
    this.name = 'InvalidDateRangeError';
  }
}

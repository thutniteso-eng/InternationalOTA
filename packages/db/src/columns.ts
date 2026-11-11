import { bigint, char, timestamp, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';

export function id(name = 'id') {
  return uuid(name)
    .primaryKey()
    .$defaultFn(() => uuidv7());
}

export function timestamps() {
  return {
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  };
}

export function money<T extends string>(name: T) {
  const minorKey = `${name}Minor` as const;
  const currencyKey = `${name}Currency` as const;

  return {
    [minorKey]: bigint(`${name}_minor`, { mode: 'bigint' }).notNull(),
    [currencyKey]: char(`${name}_currency`, { length: 3 }).notNull(),
  } as {
    [K in `${T}Minor`]: ReturnType<typeof bigint>;
  } & {
    [K in `${T}Currency`]: ReturnType<typeof char>;
  };
}

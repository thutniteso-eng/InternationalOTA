import type { ReactNode } from 'react';
import { getWebDefaultLocale } from '@/i18n/config';

export default function RootRedirectLayout({
  children,
}: {
  children: ReactNode;
}): React.JSX.Element {
  return (
    <html lang={getWebDefaultLocale()}>
      <body>{children}</body>
    </html>
  );
}

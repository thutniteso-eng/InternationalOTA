import type { ReactNode } from 'react';

export const metadata = {
  title: 'InternationalOTA',
  description: 'Independent travel platform',
};

export default function RootLayout({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

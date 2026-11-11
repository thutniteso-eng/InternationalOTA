import { formatPlatformGreeting } from '@internationalota/shared';

export default function HomePage(): React.JSX.Element {
  const greeting = formatPlatformGreeting({
    name: 'InternationalOTA',
    tagline: 'Modern Independent Travel Platform',
  });

  return (
    <main>
      <h1>InternationalOTA</h1>
      <p>{greeting}</p>
    </main>
  );
}

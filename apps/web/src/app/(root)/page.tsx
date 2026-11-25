import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { resolveWebLocale } from '@/i18n/config';

export const dynamic = 'force-dynamic';

export default async function RootRedirectPage(): Promise<never> {
  const headerStore = await headers();
  const acceptLanguage = headerStore.get('accept-language');
  const locale = resolveWebLocale(acceptLanguage);
  redirect(`/${locale}`);
}

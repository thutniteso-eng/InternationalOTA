'use client';

import { t, type BuiltinLocale } from '@internationalota/i18n';
import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import { dispatchAuthChanged } from '@/components/HeaderAuthControls';
import {
  resendVerificationEmail,
  sanitizeReturnTo,
  signInWithEmail,
  signUpWithEmail,
} from '@/lib/auth-client';

export function AuthForm({
  locale,
  mode,
  rawReturnTo,
}: {
  readonly locale: BuiltinLocale;
  readonly mode: 'sign-in' | 'sign-up';
  readonly rawReturnTo?: string | undefined;
}): React.JSX.Element {
  const safeReturnTo = sanitizeReturnTo(rawReturnTo, locale);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const isSignUp = mode === 'sign-up';
  const switchHref = rawReturnTo
    ? `/${locale}/${isSignUp ? 'sign-in' : 'sign-up'}?returnTo=${encodeURIComponent(safeReturnTo)}`
    : `/${locale}/${isSignUp ? 'sign-in' : 'sign-up'}`;

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setSubmitting(true);
    setErrorMessage(null);
    try {
      if (isSignUp) {
        const cleanEmail = email.trim();
        const res = await signUpWithEmail({
          name: name.trim(),
          email: cleanEmail,
          password,
          callbackURL: safeReturnTo,
        });
        if (!res.ok) {
          setErrorMessage(
            res.rateLimited
              ? t(locale, 'demo.auth.rateLimited')
              : (res.message ?? t(locale, 'demo.auth.genericError')),
          );
          return;
        }
        await resendVerificationEmail(cleanEmail, safeReturnTo).catch(() => null);
      } else {
        const res = await signInWithEmail({
          email: email.trim(),
          password,
        });
        if (!res.ok) {
          setErrorMessage(
            res.rateLimited
              ? t(locale, 'demo.auth.rateLimited')
              : (res.message ?? t(locale, 'demo.auth.genericError')),
          );
          return;
        }
      }

      dispatchAuthChanged();
      window.location.assign(safeReturnTo);
    } catch {
      setErrorMessage(t(locale, 'demo.auth.genericError'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="authCard">
      <h1 className="pageTitle">
        {t(locale, isSignUp ? 'demo.auth.signUpTitle' : 'demo.auth.signInTitle')}
      </h1>
      <p className="pageSubtitle">
        {t(locale, isSignUp ? 'demo.auth.signUpSubtitle' : 'demo.auth.signInSubtitle')}
      </p>

      {errorMessage ? (
        <div className="errorBox" role="alert" aria-live="assertive">
          {errorMessage}
        </div>
      ) : null}

      <form
        className="authForm"
        onSubmit={(e) => {
          void handleSubmit(e);
        }}
      >
        {isSignUp ? (
          <div className="fieldGroup">
            <label htmlFor="auth-name" className="fieldLabel">
              {t(locale, 'demo.auth.nameLabel')}
            </label>
            <input
              id="auth-name"
              name="name"
              type="text"
              required
              autoComplete="name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
              }}
              className="textInput"
            />
          </div>
        ) : null}

        <div className="fieldGroup">
          <label htmlFor="auth-email" className="fieldLabel">
            {t(locale, 'demo.auth.emailLabel')}
          </label>
          <input
            id="auth-email"
            name="email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
            }}
            className="textInput"
          />
        </div>

        <div className="fieldGroup">
          <label htmlFor="auth-password" className="fieldLabel">
            {t(locale, 'demo.auth.passwordLabel')}
          </label>
          <input
            id="auth-password"
            name="password"
            type="password"
            required
            minLength={8}
            autoComplete={isSignUp ? 'new-password' : 'current-password'}
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
            }}
            className="textInput"
          />
          {isSignUp ? <p className="fieldHint">{t(locale, 'demo.auth.passwordHint')}</p> : null}
        </div>

        <button type="submit" className="primaryButton bookButton" disabled={submitting}>
          {submitting
            ? t(locale, 'demo.auth.submitting')
            : t(locale, isSignUp ? 'demo.auth.signUpButton' : 'demo.auth.signInButton')}
        </button>
      </form>

      <p className="authSwitchRow">
        <span>
          {t(locale, isSignUp ? 'demo.auth.hasAccountPrompt' : 'demo.auth.noAccountPrompt')}
        </span>{' '}
        <Link href={switchHref}>{t(locale, isSignUp ? 'demo.nav.signIn' : 'demo.nav.signUp')}</Link>
      </p>
    </div>
  );
}

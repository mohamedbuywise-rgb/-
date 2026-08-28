-- Passkeys: نخزن الـ credential ID والمفتاح العام فقط؛ المفتاح الخاص يظل داخل مدير كلمات مرور الجهاز.
create table if not exists passkey_credentials (
  id bigint generated always as identity primary key,
  auth_user_id uuid not null,
  credential_id text not null unique,
  public_key bytea not null,
  counter bigint not null default 0,
  transports text[] not null default '{}',
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
create index if not exists idx_passkey_credentials_user on passkey_credentials (auth_user_id);

create table if not exists passkey_challenges (
  id bigint generated always as identity primary key,
  auth_user_id uuid,
  challenge text not null,
  purpose text not null check (purpose in ('registration', 'authentication')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_passkey_challenges_lookup on passkey_challenges (challenge, purpose, expires_at);

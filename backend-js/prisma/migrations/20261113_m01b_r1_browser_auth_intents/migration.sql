BEGIN;

CREATE TABLE auth_browser_contexts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  binding_digest bytea,
  generation bigint NOT NULL DEFAULT 0,
  created_at timestamptz(6) NOT NULL DEFAULT now(),
  expires_at timestamptz(6) NOT NULL,
  retired_at timestamptz(6),
  CONSTRAINT pk_auth_browser_contexts PRIMARY KEY (id),
  CONSTRAINT uq_auth_browser_contexts_binding_digest UNIQUE (binding_digest),
  CONSTRAINT ck_auth_browser_contexts_generation CHECK (generation >= 0),
  CONSTRAINT ck_auth_browser_contexts_expiry CHECK (expires_at > created_at),
  CONSTRAINT ck_auth_browser_contexts_retirement CHECK (
    (retired_at IS NULL AND binding_digest IS NOT NULL AND octet_length(binding_digest) = 32) OR
    (retired_at IS NOT NULL AND binding_digest IS NULL AND retired_at >= created_at)
  )
);
CREATE INDEX ix_auth_browser_contexts_expires_at ON auth_browser_contexts(expires_at);

CREATE TABLE auth_browser_intents (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  context_id uuid NOT NULL,
  action_id uuid NOT NULL,
  kind varchar(24) NOT NULL,
  generation bigint NOT NULL,
  accepted_at timestamptz(6) NOT NULL DEFAULT now(),
  redeem_until timestamptz(6) NOT NULL,
  claimed_at timestamptz(6),
  logout_outcome varchar(16),
  token_family_id uuid,
  session_user_id uuid,
  activated_at timestamptz(6),
  superseded_at timestamptz(6),
  CONSTRAINT pk_auth_browser_intents PRIMARY KEY (id),
  CONSTRAINT fk_auth_browser_intents_context_id FOREIGN KEY (context_id)
    REFERENCES auth_browser_contexts(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT uq_auth_browser_intents_context_action UNIQUE (context_id, action_id),
  CONSTRAINT uq_auth_browser_intents_context_generation UNIQUE (context_id, generation),
  CONSTRAINT uq_auth_browser_intents_token_family_id UNIQUE (token_family_id),
  CONSTRAINT uq_auth_browser_intents_receipt_owner UNIQUE (id, token_family_id, session_user_id),
  CONSTRAINT ck_auth_browser_intents_kind CHECK (kind IN ('google','password','phone','logout','logout_all')),
  CONSTRAINT ck_auth_browser_intents_generation CHECK (generation > 0),
  CONSTRAINT ck_auth_browser_intents_window CHECK (redeem_until > accepted_at),
  CONSTRAINT ck_auth_browser_intents_claim CHECK (
    claimed_at IS NULL OR (claimed_at >= accepted_at AND claimed_at <= redeem_until)
  ),
  CONSTRAINT ck_auth_browser_intents_logout_outcome CHECK (
    (kind IN ('logout','logout_all') AND logout_outcome IS NOT NULL AND logout_outcome IN ('completed','denied')) OR
    (kind NOT IN ('logout','logout_all') AND logout_outcome IS NULL)
  ),
  CONSTRAINT ck_auth_browser_intents_receipt CHECK (
    (kind <> 'google' AND claimed_at IS NOT NULL AND claimed_at = accepted_at AND token_family_id IS NULL AND session_user_id IS NULL AND activated_at IS NULL AND superseded_at IS NULL) OR
    (kind = 'google' AND claimed_at IS NULL AND token_family_id IS NULL AND session_user_id IS NULL AND activated_at IS NULL AND superseded_at IS NULL) OR
    (kind = 'google' AND claimed_at IS NOT NULL AND token_family_id IS NULL AND session_user_id IS NULL AND activated_at IS NULL AND superseded_at IS NULL) OR
    (kind = 'google' AND claimed_at IS NOT NULL AND token_family_id IS NOT NULL AND session_user_id IS NOT NULL AND
      activated_at IS NOT NULL AND activated_at >= claimed_at AND activated_at < redeem_until AND
      (superseded_at IS NULL OR superseded_at >= activated_at))
  )
);
CREATE INDEX ix_auth_browser_intents_context_accepted ON auth_browser_intents(context_id, accepted_at);

ALTER TABLE auth_sessions ADD COLUMN browser_intent_id uuid;
CREATE INDEX ix_auth_sessions_browser_intent_id ON auth_sessions(browser_intent_id);
ALTER TABLE auth_sessions ADD CONSTRAINT fk_auth_sessions_browser_intent_family_user
  FOREIGN KEY (browser_intent_id, token_family_id, user_id)
  REFERENCES auth_browser_intents(id, token_family_id, session_user_id)
  MATCH SIMPLE ON DELETE RESTRICT ON UPDATE RESTRICT;

COMMIT;

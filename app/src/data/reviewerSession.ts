const REVIEWER_TOKEN = /^rvw_[A-Za-z0-9_-]{43}$/;

export const REVIEWER_SESSION_STORAGE_KEY =
  "ai-challenge-room:reviewer-session-token";

function currentWindow(): Window | null {
  return typeof window === "undefined" ? null : window;
}

/** 현재 tab의 reviewer token만 읽습니다. localStorage/cookie/query는 사용하지 않습니다. */
export function reviewerSessionToken(): string | null {
  const browser = currentWindow();
  if (browser === null) return null;
  const token = browser.sessionStorage.getItem(REVIEWER_SESSION_STORAGE_KEY);
  if (token === null || !REVIEWER_TOKEN.test(token)) {
    if (token !== null) browser.sessionStorage.removeItem(REVIEWER_SESSION_STORAGE_KEY);
    return null;
  }
  return token;
}

/**
 * Local reviewer URL의 fragment를 tab-scoped sessionStorage로 한 번만 옮깁니다.
 * fragment는 network request에 포함되지 않으며 replaceState 직후 주소창에서도
 * 사라집니다. 잘못된 fragment는 저장하지 않고 fail-closed 합니다.
 */
export function bootstrapReviewerSession(): string | null {
  const browser = currentWindow();
  if (browser === null) return null;
  const fragment = browser.location.hash.startsWith("#")
    ? browser.location.hash.slice(1)
    : "";
  if (fragment.length === 0) return reviewerSessionToken();

  const parameters = new URLSearchParams(fragment);
  const tokens = parameters.getAll("reviewer_token");
  const token = tokens.length === 1 && parameters.size === 1
    ? tokens[0]
    : null;
  // valid/invalid 모두 fragment를 즉시 제거해 history·address bar에 남기지 않습니다.
  browser.history.replaceState(
    browser.history.state,
    "",
    `${browser.location.pathname}${browser.location.search}`,
  );
  if (token === null || !REVIEWER_TOKEN.test(token)) {
    browser.sessionStorage.removeItem(REVIEWER_SESSION_STORAGE_KEY);
    return null;
  }
  browser.sessionStorage.setItem(REVIEWER_SESSION_STORAGE_KEY, token);
  return token;
}

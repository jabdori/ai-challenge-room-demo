/**
 * 표준 오류는 운영자에게 실패 여부만 전달합니다. 외부 adapter·SDK의 예외 원문은
 * credential, 요청 payload 또는 공급자 내부 정보를 포함할 수 있어 출력하지 않습니다.
 */
export function calibrationSmokeFailureMessage(_error: unknown): string {
  return "Calibration smoke failed before a verified result was recorded.";
}

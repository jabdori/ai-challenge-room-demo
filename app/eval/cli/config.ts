export function requireOpenAiApiKey(environment: NodeJS.ProcessEnv): string {
  const key = environment.OPENAI_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "OPENAI_API_KEY가 없습니다. 라이브 OpenAI calibration을 실행하려면 현재 셸에만 키를 설정해 주세요.",
    );
  }

  return key;
}

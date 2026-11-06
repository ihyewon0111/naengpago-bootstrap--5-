// Vercel 서버리스 함수: 냉장고 사진 → 재료 목록
// - API 키는 코드에 넣지 말고 Vercel 대시보드 → Settings → Environment Variables 에 등록하세요.
//   OPENAI_API_KEY : 발급받은 키
//   VISION_MODEL   : 사용할 이미지 인식 모델 이름 (OpenAI 문서에서 현재 사용 가능한 모델명을 확인)
// - 키가 없으면 501을 돌려주고, 화면은 '직접 고르기 / 예시 사진 체험'으로 자동 전환됩니다.

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.VISION_MODEL;
  if (!apiKey || !model) return res.status(501).json({ error: "vision API not configured" });

  const image = req.body && req.body.image;
  if (!image || !String(image).startsWith("data:image/")) {
    return res.status(400).json({ error: "image(data URL) is required" });
  }

  const prompt =
    "냉장고 사진에서 요리에 쓸 수 있는 식재료를 찾아줘. " +
    "한국어 일반 명칭(예: 계란, 대파, 두부, 김치, 양파)으로만 적고, 확실하지 않은 건 빼. " +
    '반드시 {"ingredients": ["재료1", "재료2"]} 형식의 JSON만 출력해.';

  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        response_format: { type: "json_object" },
        messages: [{
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: image } },
          ],
        }],
      }),
    });
    if (!r.ok) return res.status(502).json({ error: `upstream ${r.status}` });
    const data = await r.json();
    const parsed = JSON.parse(data.choices[0].message.content);
    return res.status(200).json({ ingredients: Array.isArray(parsed.ingredients) ? parsed.ingredients : [] });
  } catch (err) {
    return res.status(500).json({ error: "vision failed" });
  }
};

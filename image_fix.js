/**
 * MathFetch Image Fix - v1.14-patch2
 *
 * Fixes vs v1.14-patch:
 *  1. ALL fetchAnswer messages now get a wrapped callback — not just
 *     image questions. This means "answer not found" is caught and
 *     retried with Gemini for every question type.
 *  2. Gemini is only re-called when genuinely needed:
 *       • service worker returned PROMPTIDENTIFIER AND there is an
 *         image → re-run with image data added (original behaviour)
 *       • service worker returned a failure string ("answer not found",
 *         empty, etc.) → call Gemini ourselves, with image if present
 *       • service worker returned PROMPTIDENTIFIER but NO image → just
 *         pass the text-only AI answer through (no redundant re-call)
 *  3. Prompt updated to explicitly handle multi-part questions and
 *     maxOutputTokens raised to 1024.
 */
(function () {
    const _sendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);

    // ── helpers ────────────────────────────────────────────────────────────

    async function imageToBase64(src) {
        const res = await fetch(src);
        const blob = await res.blob();
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve({
                data: reader.result.split(',')[1],
                mimeType: blob.type || 'image/png'
            });
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }

    async function callGemini(questionText, apiKey, imgSrc) {
        const textPrompt =
            'You are a maths answer key. Rules:\n' +
            '1. Output ONLY the final answer(s). No working, no explanation, no units unless the question asks for them.\n' +
            '2. If there are multiple parts (a, b, c or i, ii, iii etc.) answer EVERY part.\n' +
            '3. For multi-part questions use the format: "a) 12\\nb) 7\\nc) 3" — one answer per line, nothing else.\n' +
            '4. For single-part questions output just the answer value, e.g. "42" or "3/4".\n' +
            '5. Plain text only — no markdown, no bullet points, no full sentences.\n\n' +
            'Question:\n' + questionText;

        const parts = [{ text: textPrompt }];

        if (imgSrc) {
            try {
                const { data, mimeType } = await imageToBase64(imgSrc);
                parts.push({ inlineData: { mimeType, data } });
                console.log('[MathFetch Image Fix] Image included in Gemini request');
            } catch (e) {
                console.warn('[MathFetch Image Fix] Could not fetch image, proceeding text-only:', e);
            }
        }

        const body = {
            contents: [{ parts }],
            generationConfig: { maxOutputTokens: 1024 }
        };

        const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
            { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
        );

        const json = await res.json();
        return json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? null;
    }

    function getStorage(keys) {
        return new Promise(resolve => chrome.storage.local.get(keys, resolve));
    }

    // Whether a service-worker response represents a failure to find the answer
    function isFailure(response) {
        if (response === null || response === undefined) return true;
        if (typeof response !== 'string') return false;
        const t = response.toLowerCase().trim();
        return t === '' ||
               t === 'answer not found' ||
               t === 'not found' ||
               t.startsWith('error') ||
               t === 'undefined' ||
               t === 'null';
    }

    // ── selector for the active Sparx question container ───────────────────

    const QUESTION_SELECTOR = 'div[style*="--button-colour: #4a95ff;"]';

    // ── patched sendMessage ─────────────────────────────────────────────────

    chrome.runtime.sendMessage = function (message, callback) {
        // Only intercept answer-fetch calls that have a callback
        if (message?.type !== 'fetchAnswer' || typeof callback !== 'function') {
            return _sendMessage(message, callback);
        }

        // Snapshot image source at call time (before async gaps)
        const questionDiv = document.querySelector(QUESTION_SELECTOR);
        const img = questionDiv?.querySelector('img');
        const imgSrc = img?.src || null;

        const wrappedCallback = async (response) => {
            const isPROMPT  = typeof response === 'string' && response.startsWith('PROMPTIDENTIFIER');
            const isFailure_ = isFailure(response);

            // Case 1: Service worker used text-only AI AND there's an image
            //         → re-run Gemini with the image for a better answer
            const retryWithImage = isPROMPT && imgSrc;

            // Case 2: Service worker couldn't find any answer at all
            //         → try Gemini ourselves (with image if available)
            const fallbackToGemini = isFailure_;

            if (retryWithImage || fallbackToGemini) {
                try {
                    const { apikey, aiActive } = await getStorage(['apikey', 'aiActive']);

                    if (apikey && aiActive) {
                        console.log(
                            '[MathFetch Image Fix]',
                            retryWithImage ? 'Re-running Gemini with image' : 'Falling back to Gemini (answer not found)'
                        );
                        const result = await callGemini(message.key, apikey, imgSrc);
                        if (result) {
                            callback('PROMPTIDENTIFIER' + result);
                            return;
                        }
                        console.warn('[MathFetch Image Fix] Gemini returned no result');
                    }
                } catch (err) {
                    console.error('[MathFetch Image Fix] Gemini error:', err);
                }
            }

            // Fall through:
            // • PROMPTIDENTIFIER with no image → content script strips prefix, shows text-only AI answer ✓
            // • Failure with no API key/AI off → shows original "answer not found" ✓
            callback(response);
        };

        return _sendMessage(message, wrappedCallback);
    };

    console.log('[MathFetch Image Fix] Loaded ✓ (v2)');
})();

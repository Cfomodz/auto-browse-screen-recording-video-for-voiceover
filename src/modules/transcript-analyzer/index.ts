import OpenAI from 'openai';
import { ExtractedTopic, ModuleActionType, PipelineConfig, TranscriptSegment } from '../../core/types';
import { Logger } from '../../utils/logger';

/**
 * Transcript Analyzer module.
 *
 * Uses an LLM (Deepseek or OpenAI-compatible API) to analyze a voiceover
 * transcript and extract the main topics/concepts, along with suggested
 * browser actions for B-roll generation.
 */
export class TranscriptAnalyzer {
  private client: OpenAI;
  private model: string;
  private logger: Logger;
  private enabledActions: ModuleActionType[];

  constructor(config: PipelineConfig, logger: Logger) {
    this.logger = logger;

    // Deepseek uses the OpenAI-compatible API format
    const baseURL =
      config.llm.provider === 'deepseek'
        ? 'https://api.deepseek.com'
        : undefined;

    this.client = new OpenAI({
      apiKey: config.llm.apiKey,
      baseURL,
    });

    this.model = config.llm.model ?? (
      config.llm.provider === 'deepseek' ? 'deepseek-chat' : 'gpt-4o-mini'
    );

    // Determine which module actions are enabled
    this.enabledActions = (Object.entries(config.modules) as [ModuleActionType, { enabled: boolean }][])
      .filter(([, v]) => v.enabled)
      .map(([k]) => k);
  }

  async analyze(segments: TranscriptSegment[]): Promise<ExtractedTopic[]> {
    this.logger.info('Analyzing transcript for main topics...');

    const fullText = segments.map((s) => s.text).join(' ');
    const enabledList = this.enabledActions.join(', ');

    const systemPrompt = `You are an assistant that analyzes voiceover transcripts for video production.
Your job is to identify the main topics and concepts discussed in the transcript.
For each topic, suggest which browser actions would create good B-roll footage.

Available browser actions: ${enabledList}

- web-search: A general web search showing results for the topic
- news-search: Search and browse news headlines related to the topic
- definition-search: Look up the definition of a key term
- image-search: Browse images related to the topic

Respond with valid JSON only. No markdown fences.`;

    const userPrompt = `Analyze this voiceover transcript and extract the main topics/concepts.
For each topic, identify which transcript segments it spans (by index, 0-based)
and suggest appropriate browser actions from the available list.

Transcript segments:
${segments.map((s, i) => `[${i}] (${s.startTime.toFixed(1)}s - ${s.endTime.toFixed(1)}s): ${s.text}`).join('\n')}

Respond with a JSON array of objects with this shape:
{
  "topic": "string - the topic or concept name",
  "description": "string - brief description of the topic in context",
  "segmentIndices": [0, 1, 2],
  "suggestedActions": ["web-search", "definition-search"]
}`;

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.3,
    });

    const content = response.choices[0]?.message?.content ?? '[]';

    let parsed: Array<{
      topic: string;
      description: string;
      segmentIndices: number[];
      suggestedActions: ModuleActionType[];
    }>;

    try {
      // Strip potential markdown fences
      const cleaned = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      parsed = JSON.parse(cleaned);
    } catch (err) {
      this.logger.error(`Failed to parse LLM response: ${err}`);
      this.logger.info('Falling back to single-topic extraction from full transcript.');
      parsed = [{
        topic: this.extractFallbackTopic(fullText),
        description: 'Main topic from transcript',
        segmentIndices: segments.map((_, i) => i),
        suggestedActions: this.enabledActions,
      }];
    }

    const topics: ExtractedTopic[] = parsed.map((item) => ({
      topic: item.topic,
      description: item.description,
      segments: item.segmentIndices
        .filter((i) => i >= 0 && i < segments.length)
        .map((i) => segments[i]),
      suggestedActions: item.suggestedActions.filter((a) =>
        this.enabledActions.includes(a)
      ),
    }));

    this.logger.info(`Extracted ${topics.length} topics from transcript.`);
    return topics;
  }

  private extractFallbackTopic(text: string): string {
    // Simple heuristic: take the most frequently appearing non-stop-word
    const stopWords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
      'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
      'would', 'could', 'should', 'may', 'might', 'can', 'shall',
      'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
      'as', 'into', 'through', 'during', 'before', 'after', 'and',
      'but', 'or', 'not', 'no', 'so', 'if', 'than', 'too', 'very',
      'just', 'about', 'up', 'out', 'that', 'this', 'it', 'its',
      'they', 'them', 'their', 'we', 'our', 'you', 'your', 'he',
      'she', 'his', 'her', 'i', 'me', 'my', 'what', 'which', 'who',
    ]);

    const words = text.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/);
    const freq = new Map<string, number>();
    for (const w of words) {
      if (w.length > 3 && !stopWords.has(w)) {
        freq.set(w, (freq.get(w) ?? 0) + 1);
      }
    }

    let maxWord = 'topic';
    let maxCount = 0;
    for (const [word, count] of freq) {
      if (count > maxCount) {
        maxWord = word;
        maxCount = count;
      }
    }

    return maxWord;
  }
}

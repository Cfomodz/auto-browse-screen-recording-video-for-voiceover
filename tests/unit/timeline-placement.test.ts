import { describe, it, expect } from 'vitest';
import { placeSegmentsOnTimeline } from '../../src/modules/video-assembler';
import { topicWindow } from '../../src/core/pipeline';
import { ExtractedTopic, ModuleActionType, RecordedSegment } from '../../src/core/types';

function seg(
  name: string,
  start: number,
  end: number,
  durationSeconds: number,
  action: ModuleActionType = 'web-search'
): RecordedSegment {
  return {
    topic: { topic: name, description: name, segments: [], suggestedActions: [action] },
    action,
    filePath: `/clips/${name}_${action}.mp4`,
    durationSeconds,
    startTime: start,
    endTime: end,
  };
}

/** [file, start, end] triples for compact assertions. */
function layout(placements: ReturnType<typeof placeSegmentsOnTimeline>): Array<[string, number, number]> {
  return placements.map((p) => [p.seg.filePath.replace('/clips/', ''), p.start, p.end]);
}

describe('placeSegmentsOnTimeline', () => {
  it('plays every action recorded for one window, one after another', () => {
    const placements = placeSegmentsOnTimeline(
      [seg('a', 10, 40, 20, 'web-search'), seg('a', 10, 40, 10, 'image-search')],
      60
    );
    // The only topic gets the whole 60s: both clips play in full (30s) and
    // the 30s left over is split evenly as holds on their last frames.
    expect(layout(placements)).toEqual([
      ['a_web-search.mp4', 0, 35],
      ['a_image-search.mp4', 35, 60],
    ]);
  });

  it('gives a short clip its full length and the rest to a long one', () => {
    const placements = placeSegmentsOnTimeline(
      [seg('a', 0, 40, 8, 'definition-search'), seg('a', 0, 40, 50, 'image-search')],
      40
    );
    expect(layout(placements)).toEqual([
      ['a_definition-search.mp4', 0, 8],
      ['a_image-search.mp4', 8, 40],
    ]);
  });

  it('drops extra actions when the window is too short to show each one properly', () => {
    const logs: string[] = [];
    const placements = placeSegmentsOnTimeline(
      [
        seg('a', 0, 23, 26),
        seg('b', 23, 42, 19, 'definition-search'),
        seg('b', 23, 42, 50, 'image-search'),
        seg('c', 42, 65, 43, 'news-search'),
      ],
      90,
      (m) => logs.push(m)
    );
    // 19s cannot give two clips 12s each — the definition clip keeps it all
    expect(layout(placements)).toEqual([
      ['a_web-search.mp4', 0, 23],
      ['b_definition-search.mp4', 23, 42],
      ['c_news-search.mp4', 42, 90],
    ]);
    expect(logs.some((m) => m.includes('b_image-search.mp4'))).toBe(true);
  });

  it('starts an overlapping window where the earlier one ended (first wins)', () => {
    const placements = placeSegmentsOnTimeline([seg('b', 20, 50, 30), seg('a', 0, 30, 30)], 60);
    expect(layout(placements)).toEqual([
      ['a_web-search.mp4', 0, 30],
      ['b_web-search.mp4', 30, 60],
    ]);
  });

  it('closes gaps by letting the previous clip keep playing', () => {
    const placements = placeSegmentsOnTimeline([seg('a', 0, 10, 25), seg('b', 20, 30, 25)], 40);
    expect(layout(placements)).toEqual([
      ['a_web-search.mp4', 0, 20],
      ['b_web-search.mp4', 20, 40],
    ]);
  });

  it('drops a window that an earlier one already covers', () => {
    const logs: string[] = [];
    const placements = placeSegmentsOnTimeline(
      [seg('a', 0, 30, 30), seg('b', 10, 20, 30)],
      60,
      (m) => logs.push(m)
    );
    expect(layout(placements)).toEqual([['a_web-search.mp4', 0, 60]]);
    expect(logs.some((m) => m.includes('b_web-search.mp4'))).toBe(true);
  });

  it('drops windows that start after the voiceover ends', () => {
    const placements = placeSegmentsOnTimeline([seg('a', 0, 10, 10), seg('b', 70, 80, 10)], 60);
    expect(layout(placements)).toEqual([['a_web-search.mp4', 0, 60]]);
  });

  it('tiles the whole timeline with no gaps or overlaps', () => {
    const segments = [
      seg('a', 3, 11, 25), seg('a', 3, 11, 30, 'news-search'), seg('b', 9, 26, 28),
      seg('c', 40, 52, 22), seg('d', 41, 47, 31), seg('e', 60, 95, 27),
    ];
    const placements = placeSegmentsOnTimeline(segments, 90);
    expect(placements[0].start).toBe(0);
    expect(placements[placements.length - 1].end).toBe(90);
    for (let i = 1; i < placements.length; i++) {
      expect(placements[i].start).toBeCloseTo(placements[i - 1].end, 9);
      expect(placements[i].end).toBeGreaterThan(placements[i].start);
    }
  });

  it('returns nothing for no segments', () => {
    expect(placeSegmentsOnTimeline([], 60)).toEqual([]);
  });
});

describe('topicWindow', () => {
  function topic(ranges: Array<[number, number]>): ExtractedTopic {
    return {
      topic: 't',
      description: 't',
      segments: ranges.map(([startTime, endTime]) => ({ startTime, endTime, text: '' })),
      suggestedActions: ['web-search'],
    };
  }

  it('spans contiguous segments regardless of the order the LLM listed them', () => {
    expect(topicWindow(topic([[30, 35], [23, 30], [35, 42]]), 10)).toEqual({ startTime: 23, endTime: 42 });
  });

  it('bridges small gaps between mentions', () => {
    expect(topicWindow(topic([[0, 11], [15, 23]]), 10)).toEqual({ startTime: 0, endTime: 23 });
  });

  it('stops at a much later mention instead of claiming everything in between', () => {
    expect(topicWindow(topic([[0, 11], [11, 15], [300, 310]]), 10)).toEqual({ startTime: 0, endTime: 15 });
  });

  it('falls back to the clip duration when the topic has no segments', () => {
    expect(topicWindow(topic([]), 27)).toEqual({ startTime: 0, endTime: 27 });
  });
});

import { describe, expect, it } from 'vitest';
import {
  buildRateSchedule,
  rateCardDimensions,
  resolveRate,
  validateRateCard,
  type RateCardEntry,
} from './ratecard.js';
import { buildPricingModel } from './model.js';

/** A card with a default plus progressively more specific overrides. */
const card: RateCardEntry[] = [
  { labourCategory: 'Engineer', rate: '60.00', effectiveFrom: '2026-01-01' },
  { labourCategory: 'Engineer', location: 'Lagos', rate: '48.00', effectiveFrom: '2026-01-01' },
  {
    labourCategory: 'Engineer',
    location: 'Lagos',
    channel: 'Voice',
    rate: '52.00',
    effectiveFrom: '2026-01-01',
  },
  {
    labourCategory: 'Engineer',
    location: 'Lagos',
    channel: 'Voice',
    complexity: 'Complex',
    rate: '58.00',
    effectiveFrom: '2026-01-01',
  },
  { labourCategory: 'Engineer', channel: 'Digital', rate: '55.00', effectiveFrom: '2026-01-01' },
];

describe('resolveRate - specificity', () => {
  it('prefers the most specific matching entry', () => {
    const result = resolveRate(
      card,
      { labourCategory: 'Engineer', location: 'Lagos', channel: 'Voice', complexity: 'Complex' },
      '2026-06-01',
    );
    expect(result.rate).toBe('58.000000');
    expect(result.fellBackOn).toHaveLength(0);
  });

  it('falls back when the most specific entry does not exist', () => {
    // No Simple-complexity entry, so it lands on (Lagos, Voice).
    const result = resolveRate(
      card,
      { labourCategory: 'Engineer', location: 'Lagos', channel: 'Voice', complexity: 'Simple' },
      '2026-06-01',
    );
    expect(result.rate).toBe('52.000000');
    expect(result.fellBackOn).toEqual(['complexity']);
    expect(result.explanation).toMatch(/fell back to the default for complexity/);
  });

  it('falls back two levels', () => {
    const result = resolveRate(
      card,
      { labourCategory: 'Engineer', location: 'Lagos', channel: 'Chat', complexity: 'Simple' },
      '2026-06-01',
    );
    expect(result.rate).toBe('48.000000');
    expect(result.fellBackOn).toEqual(['channel', 'complexity']);
  });

  it('reaches the unqualified default when nothing else matches', () => {
    const result = resolveRate(
      card,
      { labourCategory: 'Engineer', location: 'Nairobi', channel: 'Chat' },
      '2026-06-01',
    );
    expect(result.rate).toBe('60.000000');
    expect(result.specificity).toBe(0);
    expect(result.explanation).toMatch(/Matched the default rate/);
  });

  it('weights location above channel, so the tie is deterministic', () => {
    // (Lagos, *) scores 4; (*, Digital) scores 2. Location wins.
    const result = resolveRate(
      card,
      { labourCategory: 'Engineer', location: 'Lagos', channel: 'Digital' },
      '2026-06-01',
    );
    expect(result.rate).toBe('48.000000');
    expect(result.specificity).toBe(4);
  });

  it('matches a channel-only entry when the location is unknown to the card', () => {
    const result = resolveRate(
      card,
      { labourCategory: 'Engineer', location: 'Nairobi', channel: 'Digital' },
      '2026-06-01',
    );
    expect(result.rate).toBe('55.000000');
    expect(result.fellBackOn).toEqual(['location']);
  });

  it('is case-insensitive on dimensions and category', () => {
    const result = resolveRate(
      card,
      { labourCategory: 'engineer', location: 'LAGOS', channel: 'voice' },
      '2026-06-01',
    );
    expect(result.rate).toBe('52.000000');
  });

  it('does not use a specific entry when the query omits that dimension', () => {
    // Asking for Engineer with no location must not silently pick the Lagos rate.
    const result = resolveRate(card, { labourCategory: 'Engineer' }, '2026-06-01');
    expect(result.rate).toBe('60.000000');
  });

  it('explains an unknown labour category rather than returning nothing', () => {
    expect(() => resolveRate(card, { labourCategory: 'Astronaut' }, '2026-06-01')).toThrow(
      /No rate is in force for 'Astronaut'/,
    );
  });
});

describe('resolveRate - effective dating', () => {
  const dated: RateCardEntry[] = [
    {
      labourCategory: 'Tech',
      rate: '40.00',
      effectiveFrom: '2026-01-01',
      effectiveTo: '2027-01-01',
    },
    {
      labourCategory: 'Tech',
      rate: '44.00',
      effectiveFrom: '2027-01-01',
      effectiveTo: '2028-01-01',
    },
    { labourCategory: 'Tech', rate: '47.00', effectiveFrom: '2028-01-01' },
  ];

  it('returns the rate in force on the date', () => {
    expect(resolveRate(dated, { labourCategory: 'Tech' }, '2026-06-01').rate).toBe('40.000000');
    expect(resolveRate(dated, { labourCategory: 'Tech' }, '2027-06-01').rate).toBe('44.000000');
    expect(resolveRate(dated, { labourCategory: 'Tech' }, '2029-06-01').rate).toBe('47.000000');
  });

  it('treats effectiveFrom as inclusive and effectiveTo as exclusive', () => {
    expect(resolveRate(dated, { labourCategory: 'Tech' }, '2027-01-01').rate).toBe('44.000000');
    expect(resolveRate(dated, { labourCategory: 'Tech' }, '2026-12-31').rate).toBe('40.000000');
  });

  it('throws before the card begins', () => {
    expect(() => resolveRate(dated, { labourCategory: 'Tech' }, '2025-06-01')).toThrow(
      /does not cover that date/,
    );
  });

  it('honours an open-ended final entry', () => {
    expect(resolveRate(dated, { labourCategory: 'Tech' }, '2099-01-01').rate).toBe('47.000000');
  });
});

describe('validateRateCard', () => {
  it('accepts a clean card', () => {
    expect(validateRateCard(card).valid).toBe(true);
  });

  it('rejects two entries in force at once for the same dimensions', () => {
    const overlapping: RateCardEntry[] = [
      {
        labourCategory: 'Tech',
        rate: '40',
        effectiveFrom: '2026-01-01',
        effectiveTo: '2027-06-01',
      },
      { labourCategory: 'Tech', rate: '44', effectiveFrom: '2027-01-01' },
    ];
    const result = validateRateCard(overlapping);
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.kind).toBe('OVERLAP');
    expect(result.issues[0]?.message).toMatch(/both in force at the same time/);
  });

  it('rejects two open-ended entries for the same dimensions', () => {
    const result = validateRateCard([
      { labourCategory: 'Tech', rate: '40', effectiveFrom: '2026-01-01' },
      { labourCategory: 'Tech', rate: '44', effectiveFrom: '2027-01-01' },
    ]);
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.kind).toBe('OVERLAP');
  });

  it('allows abutting ranges, which do not overlap', () => {
    expect(
      validateRateCard([
        {
          labourCategory: 'Tech',
          rate: '40',
          effectiveFrom: '2026-01-01',
          effectiveTo: '2027-01-01',
        },
        { labourCategory: 'Tech', rate: '44', effectiveFrom: '2027-01-01' },
      ]).valid,
    ).toBe(true);
  });

  it('does not flag overlap across different dimensions', () => {
    expect(
      validateRateCard([
        { labourCategory: 'Tech', location: 'Lagos', rate: '40', effectiveFrom: '2026-01-01' },
        { labourCategory: 'Tech', location: 'Abuja', rate: '44', effectiveFrom: '2026-01-01' },
      ]).valid,
    ).toBe(true);
  });

  it('rejects an inverted range and a negative rate', () => {
    const result = validateRateCard([
      { labourCategory: 'A', rate: '40', effectiveFrom: '2027-01-01', effectiveTo: '2026-01-01' },
      { labourCategory: 'B', rate: '-5', effectiveFrom: '2026-01-01' },
    ]);
    expect(result.issues.map((i) => i.kind)).toContain('INVALID_RANGE');
    expect(result.issues.map((i) => i.kind)).toContain('NEGATIVE_RATE');
  });

  it('rejects an unparseable date', () => {
    expect(() =>
      validateRateCard([{ labourCategory: 'A', rate: '1', effectiveFrom: 'not-a-date' }]),
    ).toThrow(/is not a valid date/);
  });
});

describe('buildRateSchedule', () => {
  const dated: RateCardEntry[] = [
    {
      labourCategory: 'Tech',
      rate: '40.00',
      effectiveFrom: '2026-01-01',
      effectiveTo: '2027-01-01',
    },
    {
      labourCategory: 'Tech',
      rate: '44.00',
      effectiveFrom: '2027-01-01',
      effectiveTo: '2028-01-01',
    },
    { labourCategory: 'Tech', rate: '47.00', effectiveFrom: '2028-01-01' },
  ];

  it('prices each contract year at the rate in force on its anniversary', () => {
    const schedule = buildRateSchedule(
      dated,
      { labourCategory: 'Tech' },
      {
        startDate: '2026-01-01',
        years: 3,
      },
    );
    expect(schedule.ratesByYear).toEqual(['40.000000', '44.000000', '47.000000']);
  });

  it('flags the years where the rate changed', () => {
    const schedule = buildRateSchedule(
      dated,
      { labourCategory: 'Tech' },
      {
        startDate: '2026-01-01',
        years: 3,
      },
    );
    expect(schedule.entries[0]?.changed).toBe(false);
    expect(schedule.entries[1]?.changed).toBe(true);
    expect(schedule.warnings.join(' ')).toMatch(/rate changes 2 time\(s\)/);
  });

  it('holds a flat card flat', () => {
    const schedule = buildRateSchedule(
      card,
      { labourCategory: 'Engineer' },
      {
        startDate: '2026-01-01',
        years: 3,
      },
    );
    expect(schedule.ratesByYear).toEqual(['60.000000', '60.000000', '60.000000']);
    expect(schedule.warnings).toHaveLength(0);
  });

  it('escalates beyond the end of the card and says so', () => {
    const closing: RateCardEntry[] = [
      {
        labourCategory: 'Tech',
        rate: '100.00',
        effectiveFrom: '2026-01-01',
        effectiveTo: '2028-01-01',
      },
    ];
    const schedule = buildRateSchedule(
      closing,
      { labourCategory: 'Tech' },
      {
        startDate: '2026-01-01',
        years: 4,
        escalationBeyondCard: '0.05',
      },
    );

    // Years 1-2 from the card; years 3-4 escalated at 5% compounding.
    expect(schedule.ratesByYear[0]).toBe('100.000000');
    expect(schedule.ratesByYear[1]).toBe('100.000000');
    expect(schedule.ratesByYear[2]).toBe('105.000000');
    expect(schedule.ratesByYear[3]).toBe('110.250000');
    expect(schedule.entries[2]?.source).toBe('ESCALATED');
    expect(schedule.warnings.join(' ')).toMatch(/not agreed rates/);
  });

  it('holds flat beyond the card when no escalation is given', () => {
    const closing: RateCardEntry[] = [
      {
        labourCategory: 'Tech',
        rate: '100.00',
        effectiveFrom: '2026-01-01',
        effectiveTo: '2027-01-01',
      },
    ];
    const schedule = buildRateSchedule(
      closing,
      { labourCategory: 'Tech' },
      {
        startDate: '2026-01-01',
        years: 3,
      },
    );
    expect(schedule.ratesByYear).toEqual(['100.000000', '100.000000', '100.000000']);
  });

  it('throws when the card does not cover the start date at all', () => {
    expect(() =>
      buildRateSchedule(dated, { labourCategory: 'Tech' }, { startDate: '2020-01-01', years: 2 }),
    ).toThrow(/does not cover that date/);
  });

  it('rejects an out-of-range term', () => {
    expect(() =>
      buildRateSchedule(dated, { labourCategory: 'Tech' }, { startDate: '2026-01-01', years: 0 }),
    ).toThrow(/between 1 and 20 years/);
  });
});

describe('pricing from a rate schedule', () => {
  it('uses ratesByYear in preference to baseRate and escalation', () => {
    // 1,000 hours a year at 40 / 44 / 47 = 40,000 + 44,000 + 47,000 = 131,000
    const result = buildPricingModel({
      name: 'Rate card driven',
      contractType: 'TIME_AND_MATERIALS',
      years: 3,
      labour: [
        {
          labourCategory: 'Tech',
          hoursByYear: [1000, 1000, 1000],
          baseRate: '999.00', // must be ignored
          escalationRate: '0.50', // must be ignored
          ratesByYear: ['40.00', '44.00', '47.00'],
        },
      ],
      feeRate: '0',
    });

    expect(result.totals.directLabour).toBe('131000.0000');
    expect(result.years[0]?.directLabour).toBe('40000.0000');
    expect(result.years[2]?.directLabour).toBe('47000.0000');
  });

  it('still honours baseRate and escalation when no schedule is supplied', () => {
    // 1,000h x 100 escalating 10%: 100,000 + 110,000 = 210,000
    const result = buildPricingModel({
      name: 'Escalation driven',
      contractType: 'TIME_AND_MATERIALS',
      years: 2,
      labour: [
        {
          labourCategory: 'Tech',
          hoursByYear: [1000, 1000],
          baseRate: '100.00',
          escalationRate: '0.10',
        },
      ],
      feeRate: '0',
    });
    expect(result.totals.directLabour).toBe('210000.0000');
  });

  it('holds the last scheduled rate flat if the schedule is shorter than the term', () => {
    const result = buildPricingModel({
      name: 'Short schedule',
      contractType: 'TIME_AND_MATERIALS',
      years: 3,
      labour: [
        {
          labourCategory: 'Tech',
          hoursByYear: [100, 100, 100],
          baseRate: '0',
          ratesByYear: ['10.00', '20.00'],
        },
      ],
      feeRate: '0',
    });
    // 1,000 + 2,000 + 2,000 (year 3 holds year 2's rate)
    expect(result.totals.directLabour).toBe('5000.0000');
  });
});

describe('rateCardDimensions', () => {
  it('lists the distinct values present, sorted, without wildcards', () => {
    const dimensions = rateCardDimensions(card);
    expect(dimensions.labourCategories).toEqual(['Engineer']);
    expect(dimensions.locations).toEqual(['Lagos']);
    expect(dimensions.channels).toEqual(['Digital', 'Voice']);
    expect(dimensions.complexities).toEqual(['Complex']);
  });

  it('returns empty lists for an empty card', () => {
    const dimensions = rateCardDimensions([]);
    expect(dimensions.labourCategories).toHaveLength(0);
    expect(dimensions.locations).toHaveLength(0);
  });
});

# Accessibility

Where this platform stands on accessibility, what has been done, and what has not been
established.

**Position: WCAG 2.1 Level AA is the target. It has not been audited, and no conformance claim is
made.** That is the honest statement, and it is more useful to a procuring organisation than
silence or an unverified badge.

Stated because it gets asked early — by public-sector buyers, by enterprise procurement, and by
anyone with an accessibility policy of their own. "We have not assessed it" is an answer they can
work with. "No response" is not.

---

## What is in place

Verified by reading the source, not by an audit tool.

| Practice                                     | Evidence in `packages/web`                                                                                                               |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Labelled form controls**                   | 25 `<label>` elements with 29 `htmlFor` bindings — inputs are programmatically associated with their labels, not merely adjacent to them |
| **Status announced to assistive technology** | 8 `role="alert"` and 3 `role="status"` regions, with `aria-live` where content updates in place                                          |
| **Decorative content hidden**                | 12 `aria-hidden` attributes on icons that duplicate adjacent text                                                                        |
| **Disclosure state exposed**                 | `aria-expanded` / `aria-controls` on collapsible sections                                                                                |
| **Tabs given the right roles**               | `role="tablist"` / `role="tabpanel"` with `aria-labelledby`                                                                              |
| **Semantic HTML**                            | Native `<button>`, `<table>`, `<label>` rather than styled `<div>`s, so keyboard and screen-reader behaviour comes for free              |
| **Theme with a dark mode**                   | Respects the user's preference rather than forcing one                                                                                   |

Error messages are text, not colour alone — a refused approval says _why_ it was refused. That
matters beyond accessibility, but it is the specific thing WCAG 1.4.1 asks for.

---

## What has not been established

This is the part a procurement questionnaire actually needs.

- **No manual assessment.** An automated scan now runs (see below); no human assessment has. Nothing
  here should be read as a conformance claim.
- **Colour contrast unmeasured.** The palette was chosen for legibility but the ratios have not
  been computed against 4.5:1 for body text or 3:1 for large text. Both themes need checking.
- **Keyboard navigation untested end to end.** Semantic HTML means most of it should work, but
  "should" is not "does" — focus order, focus visibility and keyboard traps in modals and the
  pricing workbench are unverified.
- **No screen-reader testing.** Not with NVDA, JAWS or VoiceOver.
- **Zoom and reflow at 320px unverified** (WCAG 1.4.10).
- **Focus order and focus visibility unverified** by hand, particularly in the pricing workbench.

Three items previously listed here have been **corrected and are no longer gaps**. They are
recorded rather than deleted, because a document that quietly improves its own history is not
worth trusting:

- _"Charts are not accessible."_ Fixed. Every chart is now an `AccessibleChart`: a `role="img"`
  with a summary stating what it shows, the raw SVG hidden from assistive technology, and the
  figures carried as a real table — visually hidden where the page does not already show one.
- _"No skip-to-content link."_ This was **never true**. `Layout.tsx` has had one throughout.
- _"Data tables lack `<caption>` and scope attributes."_ This was **almost entirely untrue**: 39
  of 40 tables carried captions and there were 190 `scope` attributes. The one exception, the
  reference-data import preview, now has both.

The last two were wrong when written, which is worth saying plainly: an accessibility statement
that overstates its gaps is still an inaccurate statement, and it was corrected only because a
scan was finally run against the code rather than against the memory of it.

---

## What the automated scan now covers

`npm run test:ui:a11y` runs **axe-core** against every screen, as three different roles render it,
plus the signed-out login page — 38 assertions. As of 2026-08-14 it reports **zero violations at
any impact level** against WCAG 2.1 A and AA.

It found two real defects on its first run, both since fixed:

- **Muted body text failed contrast**, at 4.34:1 against the page background where 4.5:1 is
  required. It passed on white cards and failed on the page itself, which is why reading the code
  would never have found it. 28 occurrences across nearly every screen.
- **Empty risk heat-map cells were drawn at 40% opacity**, taking their labels to **1.96:1** — the
  worst failure in the product. Opacity fades text and background together, so nothing below about
  78% passes here, by which point the de-emphasis is pointless. Empty cells are now drawn neutral.

**What a clean scan does not mean.** axe-core catches roughly a third of WCAG issues — the
mechanical ones. It cannot judge whether a label is meaningful, whether focus order makes sense,
or whether a chart's text alternative conveys the trend rather than merely the numbers. This is a
floor, not a conformance claim.

---

## If you need a conformance statement

The order that gets there fastest:

1. ~~**Automated scan** (axe-core)~~ — **done**, and green. It is not in CI because CI has no
   browser; it runs from `npm run test:ui:a11y` against the live stack.
2. **Keyboard pass** by hand, on the six main screens. A morning. This is now the first
   outstanding item.
3. **Fix what those two find**, which is the unknown-sized part.
4. **Screen-reader pass** on the primary flows: sign in, open a budget, submit it.
5. **Manual WCAG AA audit** for anything that must be formally attested. This is the point at
   which an external assessor is worth paying for, not before.

Steps 1 and 2 would move this document from "not established" to a defensible position on most
rows. Nothing above is blocked on anything else.

---

## Not in scope

- **Mobile.** The platform targets desktop browsers; it is a finance workstation tool. Small-screen
  behaviour is not designed for and not tested.
- **Browser support** is not formally stated either. Development and verification happen on current
  Chrome; nothing depends on a Chrome-only API, but no compatibility matrix has been established.

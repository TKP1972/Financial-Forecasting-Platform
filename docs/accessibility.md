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

- **No audit.** No automated scan (axe, Lighthouse) and no manual assessment has been run. Nothing
  here should be read as a conformance claim.
- **Colour contrast unmeasured.** The palette was chosen for legibility but the ratios have not
  been computed against 4.5:1 for body text or 3:1 for large text. Both themes need checking.
- **Keyboard navigation untested end to end.** Semantic HTML means most of it should work, but
  "should" is not "does" — focus order, focus visibility and keyboard traps in modals and the
  pricing workbench are unverified.
- **No screen-reader testing.** Not with NVDA, JAWS or VoiceOver.
- **Charts are not accessible.** The dashboard uses Recharts, which renders SVG with no text
  alternative. **A screen-reader user currently cannot read the charts at all.** The underlying
  figures are available in adjacent tables in most places, but not all, and that is not a
  substitute for an equivalent.
- **No skip-to-content link**, so a keyboard user tabs through the navigation on every page.
- **Data tables lack `<caption>` and scope attributes**, which makes them harder to navigate by
  screen reader than their semantic markup suggests.
- **Zoom and reflow at 320px unverified** (WCAG 1.4.10).

---

## Known to be the largest gap

**Charts.** Everything else on this list is a day or two of work. A genuinely accessible chart is
a different problem: it needs a text alternative that conveys the trend, not just the numbers, and
usually a table view as a first-class alternative rather than a fallback.

If an accessibility requirement is firm, raise charts first. It is the one item that could change
a delivery estimate.

---

## If you need a conformance statement

The order that gets there fastest:

1. **Automated scan** (axe-core in CI) — catches contrast, missing labels and ARIA misuse cheaply,
   and would have caught most of the unknowns above. Roughly half a day to wire in.
2. **Keyboard pass** by hand, on the six main screens. A morning.
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

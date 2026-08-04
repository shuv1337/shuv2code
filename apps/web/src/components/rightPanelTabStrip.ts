export interface HorizontalWheelScrollInput {
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
  deltaX: number;
  deltaY: number;
  deltaMode: number;
}

const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;

export function resolveHorizontalWheelScroll(input: HorizontalWheelScrollInput): number | null {
  if (Math.abs(input.deltaY) <= Math.abs(input.deltaX)) return null;

  const maxScrollLeft = Math.max(0, input.scrollWidth - input.clientWidth);
  const unit =
    input.deltaMode === DOM_DELTA_LINE
      ? 24
      : input.deltaMode === DOM_DELTA_PAGE
        ? input.clientWidth
        : 1;
  const nextScrollLeft = Math.max(
    0,
    Math.min(maxScrollLeft, input.scrollLeft + input.deltaY * unit),
  );
  return nextScrollLeft === input.scrollLeft ? null : nextScrollLeft;
}

export type TabNavigationKey = "ArrowLeft" | "ArrowRight" | "Home" | "End";

export function resolveTabNavigationIndex(
  key: TabNavigationKey,
  currentIndex: number,
  tabCount: number,
): number | null {
  if (currentIndex < 0 || currentIndex >= tabCount || tabCount <= 0) return null;
  switch (key) {
    case "ArrowLeft":
      return (currentIndex - 1 + tabCount) % tabCount;
    case "ArrowRight":
      return (currentIndex + 1) % tabCount;
    case "Home":
      return 0;
    case "End":
      return tabCount - 1;
  }
}

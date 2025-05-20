import { isTabbable, tabbable } from "tabbable";

function getTabbable(
  method: 'previousElementSibling' | 'nextElementSibling',
  element: Element | null,
  container: Node
): HTMLElement | SVGElement | null {
  if (!element) {
    return null;
  }

  if (element.parentElement === container) {
    return null;
  }

  if (!container.contains(element)) {
    return null;
  }

  let candidate = element;

  if (isTabbable(candidate)) {
    return candidate as HTMLElement | SVGElement;
  }

  candidate = candidate[method] as Element;
  while (candidate) {
    const tabbableElements = tabbable(candidate);

    if (tabbableElements.length > 0) {
      return tabbableElements[tabbableElements.length - 1] as HTMLElement | SVGElement;
    }

    candidate = candidate[method] as Element;
  }

  return getTabbable(method, element.parentElement, container)
}

export const getPreviousTabbable = getTabbable.bind(null, 'previousElementSibling');

export const getNextTabbable = getTabbable.bind(null, 'nextElementSibling');

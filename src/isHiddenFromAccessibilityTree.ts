import { tabbable } from "tabbable";
import { isElement } from "./isElement";

const TEXT_NODE = 3;

let warned = false;

export function isHiddenFromAccessibilityTree(node: Node | null): node is null {
  if (!node) {
    return true;
  }

  // `node.textContent` is only `null` for `document` and `doctype`.

  if (node.nodeType === TEXT_NODE && node.textContent!.trim()) {
    return false;
  }

  if (!isElement(node)) {
    return true;
  }

  try {
    if (node.hidden === true) {
      return true;
    }

    if (node.getAttribute("aria-hidden") === "true") {
      if (tabbable(node).length === 0) {
        return true;
      }
      if (!warned) {
        console.warn('ignoring aria-hidden since node has tabbable children', node);
        warned = true;
      }
    }

    const getComputedStyle = node.ownerDocument.defaultView?.getComputedStyle;
    const computedStyle = getComputedStyle?.(node);

    if (
      computedStyle?.visibility === "hidden" ||
      computedStyle?.display === "none"
    ) {
      return true;
    }
  } catch {
    // Some elements aren't supported by DOM implementations such as JSDOM.
    // E.g. `<math>`, see https://github.com/jsdom/jsdom/issues/3515
    // We ignore these nodes at the moment as we can't support them.
    return true;
  }

  return false;
}

import { ARIARole, roles } from "html-aria";
import { getRole, presentationRoles } from "./getRole";
import { getAccessibleDescription } from "./getAccessibleDescription";
import { getAccessibleName } from "./getAccessibleName";
import { getAccessibleValue } from "./getAccessibleValue";
import { getLocalName } from "../getLocalName";
import { isDialogRole } from "../isDialogRole";
import { isElement } from "../isElement";

const childrenPresentationalRoles = new Set(
  Object.entries(roles)
    .filter(([, { childrenPresentational }]) => childrenPresentational)
    .map(([key]) => key) as string[]
);

const getSpokenRole = ({
  isGeneric,
  isPresentational,
  node,
  role,
}: {
  isGeneric: boolean;
  isPresentational: boolean;
  node: Node;
  role: string;
}) => {
  if (isPresentational || isGeneric) {
    return "";
  }

  if (isElement(node)) {
    /**
     * Assistive technologies SHOULD use the value of aria-roledescription when
     * presenting the role of an element, but SHOULD NOT change other
     * functionality based on the role of an element that has a value for
     * aria-roledescription. For example, an assistive technology that provides
     * functions for navigating to the next region or button SHOULD allow those
     * functions to navigate to regions and buttons that have an
     * aria-roledescription.
     *
     * REF: https://www.w3.org/TR/wai-aria-1.2/#aria-roledescription
     */
    const roledescription = node.getAttribute("aria-roledescription");

    if (roledescription) {
      return roledescription;
    }
  }

  return role;
};

/**
 * Nodes that are [inert](https://html.spec.whatwg.org/multipage/interaction.html#inert)
 * are not exposed to an accessibility API.
 *
 * Note: an inert node can have descendants that are not inert. For example,
 * a [modal dialog](https://html.spec.whatwg.org/multipage/interaction.html#modal-dialogs-and-inert-subtrees)
 * can escape an inert subtree.
 *
 * REF: https://www.w3.org/TR/html-aam-1.0/#att-inert
 */
const getIsInert = ({
  inheritedImplicitInert,
  node,
  role,
}: {
  inheritedImplicitInert: boolean;
  node: Node;
  role: string;
}) => {
  if (!isElement(node)) {
    return inheritedImplicitInert;
  }

  // TODO: this doesn't cater to `<dialog>` elements which are model if opened
  // by `show()` vs `showModal()`.
  // REF: https://html.spec.whatwg.org/multipage/interaction.html#modal-dialogs-and-inert-subtrees
  const isNativeModalDialog =
    getLocalName(node) === "dialog" && node.hasAttribute("open");

  const isNonNativeModalDialog =
    isDialogRole(role) && node.hasAttribute("aria-modal");

  const isModalDialog = isNonNativeModalDialog || isNativeModalDialog;
  const isExplicitInert = node.hasAttribute("inert");

  return isExplicitInert || (inheritedImplicitInert && !isModalDialog);
};

export function getNodeAccessibilityData({
  allowedAccessibilityRoles,
  inheritedImplicitInert,
  inheritedImplicitPresentational,
  node,
}: {
  allowedAccessibilityRoles: string[];
  inheritedImplicitInert: boolean;
  inheritedImplicitPresentational: boolean;
  node: Node;
}) {
  const accessibleDescription = getAccessibleDescription(node);
  const accessibleName = getAccessibleName(node);
  const accessibleValue = getAccessibleValue(node);

  const { explicitRole, implicitRole, role } = getRole({
    accessibleName,
    allowedAccessibilityRoles,
    inheritedImplicitPresentational,
    node,
  });

  const amendedAccessibleDescription =
    accessibleDescription === accessibleName ? "" : accessibleDescription;

  const isExplicitPresentational = presentationRoles.has(explicitRole);
  const isPresentational = presentationRoles.has(role);
  const isGeneric = role === "generic";

  const spokenRole = getSpokenRole({
    isGeneric,
    isPresentational,
    node,
    role,
  });

  const { allowedChildRoles: allowedAccessibilityChildRoles } = roles[
    role as ARIARole
  ] ?? {
    allowedChildRoles: [],
  };

  const { allowedChildRoles: implicitAllowedAccessibilityChildRoles } = roles[
    implicitRole as ARIARole
  ] ?? {
    allowedChildRoles: [],
  };

  /**
   * Any descendants of elements that have the characteristic "Children
   * Presentational: True" unless the descendant is not allowed to be
   * presentational because it meets one of the conditions for exception
   * described in Presentational Roles Conflict Resolution. However, the text
   * content of any excluded descendants is included.
   *
   * REF: https://www.w3.org/TR/wai-aria-1.2/#tree_exclusion
   */
  const isChildrenPresentationalRole = childrenPresentationalRoles.has(role);

  /**
   * When an explicit or inherited role of presentation is applied to an
   * element with the implicit semantic of a WAI-ARIA role that has Allowed
   * Accessibility Child Roles, in addition to the element with the explicit
   * role of presentation, the user agent MUST apply an inherited role of
   * presentation to any owned elements that do not have an explicit role
   * defined. Also, when an explicit or inherited role of presentation is
   * applied to a host language element which has specifically allowed children
   * as defined by the host language specification, in addition to the element
   * with the explicit role of presentation, the user agent MUST apply an
   * inherited role of presentation to any specifically allowed children that
   * do not have an explicit role defined.
   *
   * REF: https://www.w3.org/TR/wai-aria-1.2/#presentational-role-inheritance
   */
  const isExplicitOrInheritedPresentation =
    isExplicitPresentational || inheritedImplicitPresentational;
  const isElementWithImplicitAllowedAccessibilityChildRoles =
    !!implicitAllowedAccessibilityChildRoles.length;
  const childrenInheritPresentationExceptAllowedRoles =
    isExplicitOrInheritedPresentation &&
    isElementWithImplicitAllowedAccessibilityChildRoles;

  const childrenPresentational =
    isChildrenPresentationalRole ||
    childrenInheritPresentationExceptAllowedRoles;

  const isInert = getIsInert({
    inheritedImplicitInert,
    node,
    role,
  });

  return {
    accessibleDescription: amendedAccessibleDescription,
    accessibleName,
    accessibleValue,
    allowedAccessibilityChildRoles,
    childrenPresentational,
    isExplicitPresentational,
    isInert,
    role,
    spokenRole,
  };
}

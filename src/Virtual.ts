import {
  AccessibilityNode,
  createAccessibilityTree,
} from "./createAccessibilityTree";
import { commands, type VirtualCommands } from "./commands/index";
import {
  ERR_VIRTUAL_MISSING_CONTAINER,
  ERR_VIRTUAL_NOT_STARTED,
} from "./errors";
import { getLiveSpokenPhrase, LIVE } from "./getLiveSpokenPhrase";
import { flattenTree } from "./flattenTree";
import { getElementNode } from "./commands/getElementNode";
import { getItemText } from "./getItemText";
import { getSpokenPhrase } from "./getSpokenPhrase";
import { observeDOM } from "./observeDOM";
import { tick } from "./tick";
import { userEvent } from "@testing-library/user-event";
import type { VirtualCommandArgs } from "./commands/types";

/**
 * Modifiers ported from https://github.com/guidepup/guidepup to prevent ESM
 * issues by Guidepup's usage of node builtins etc.
 */

const MacOSModifiers: Record<string, string> = {
  /**
   * The Command (alias cmd, ⌘) key.
   */
  Command: "command",
  CommandLeft: "command",
  CommandRight: "command",
  Meta: "command",
  /**
   * The Control (alias ctrl, ⌃) key.
   */
  Control: "control",
  ControlLeft: "control",
  ControlRight: "control",
  /**
   * The Option (alias alt, ⌥) key.
   */
  Option: "option",
  OptionLeft: "option",
  OptionRight: "option",
  Alt: "option",
  AltLeft: "option",
  AltRight: "option",
  /**
   * The Shift (alias ⇧) key.
   */
  Shift: "shift",
  ShiftLeft: "shift",
  ShiftRight: "shift",
};

const WindowsModifiers: Record<string, string> = {
  /**
   * Hold down the Control (alias ctrl, ⌃) key.
   */
  Control: "control",
  /**
   * Hold down the Alt (alias ⎇) key.
   */
  Alt: "alt",
  /**
   * Hold down the Shift (alias ⇧) key.
   */
  Shift: "shift",
};

export interface Root {
  document?: Document;
  MutationObserver?: typeof MutationObserver;
}

export interface StartOptions {
  /**
   * The bounding HTML element to use the Virtual Screen Reader in.
   *
   * To use the entire page pass `document.body`.
   */
  container: Node;

  /**
   * The window instance.
   *
   * Only required if the `window` instance is not already globally available.
   * For example, when you are in a Node environment and using a custom DOM
   * implementation that is not attached to the global scope.
   *
   * Defaults to using the global `window` instance.
   */
  window?: Root;

  /**
   * Display the Virtual Screen Reader cursor visually on the target element.
   *
   * Note: There is a performance overhead to visually rendering the cursor.
   *
   * Defaults to `false`.
   */
  displayCursor?: boolean;
}

const defaultUserEventOptions = {
  delay: 0,
  skipHover: true,
};

/**
 * TODO: When a modal element is displayed, assistive technologies SHOULD
 * navigate to the element unless focus has explicitly been set elsewhere.
 *
 * REF: https://www.w3.org/TR/wai-aria-1.2/#aria-modal
 */

/**
 * TODO: When an assistive technology reading cursor moves from one article to
 * another, assistive technologies SHOULD set user agent focus on the article
 * that contains the reading cursor. If the reading cursor lands on a focusable
 * element inside the article, the assistive technology MAY set focus on that
 * element in lieu of setting focus on the containing article.
 *
 * REF: https://www.w3.org/TR/wai-aria-1.2/#feed
 */

/**
 * [API Reference](https://www.guidepup.dev/docs/api/class-virtual)
 *
 * A Virtual Screen Reader class that can be used to launch and control a
 * headless JavaScript screen reader which is compatible with any specification
 * compliant DOM implementation, e.g. jsdom, Jest, or any modern browser.
 *
 * Here's a typical example:
 *
 * ```ts
 * import { Virtual } from "@guidepup/virtual-screen-reader";
 *
 * function setupBasicPage() {
 *   document.body.innerHTML = `
 *   <nav>Nav Text</nav>
 *   <section>
 *     <h1>Section Heading</h1>
 *     <p>Section Text</p>
 *     <article>
 *       <header>
 *         <h1>Article Header Heading</h1>
 *         <p>Article Header Text</p>
 *       </header>
 *       <p>Article Text</p>
 *     </article>
 *   </section>
 *   <footer>Footer</footer>
 *   `;
 * }
 *
 * describe("Screen Reader Tests", () => {
 *   test("should traverse the page announcing the expected roles and content", async () => {
 *     // Setup a page using a framework and testing library of your choice
 *     setupBasicPage();
 *
 *     // Create a new Virtual Screen Reader instance
 *     const virtual = new Virtual();
 *
 *     // Start your Virtual Screen Reader instance
 *     await virtual.start({ container: document.body });
 *
 *     // Navigate your environment with the Virtual Screen Reader just as your users would
 *     while ((await virtual.lastSpokenPhrase()) !== "end of document") {
 *       await virtual.next();
 *     }
 *
 *     // Assert on what your users would really see and hear when using screen readers
 *     expect(await virtual.spokenPhraseLog()).toEqual([
 *       "document",
 *       "navigation",
 *       "Nav Text",
 *       "end of navigation",
 *       "region",
 *       "heading, Section Heading, level 1",
 *       "Section Text",
 *       "article",
 *       "heading, Article Header Heading, level 1",
 *       "Article Header Text",
 *       "Article Text",
 *       "end of article",
 *       "end of region",
 *       "contentinfo",
 *       "Footer",
 *       "end of contentinfo",
 *       "end of document",
 *     ]);
 *
 *     // Stop your Virtual Screen Reader instance
 *     await virtual.stop();
 *   });
 * });
 * ```
 */
export class Virtual {
  #activeNode: AccessibilityNode | null = null;
  #container: Node | null = null;
  #cursor: HTMLDivElement | null = null;
  #itemTextLog: string[] = [];
  #spokenPhraseLog: string[] = [];
  #treeCache: AccessibilityNode[] | null = null;
  #disconnectDOMObserver: (() => void) | null = null;
  #boundHandleFocusChange: ((event: Event) => Promise<void>) | null = null;

  #checkContainer() {
    if (!this.#container) {
      throw new Error(ERR_VIRTUAL_NOT_STARTED);
    }
  }

  #createCursor(root: Root | undefined) {
    if (!root?.document) {
      return;
    }

    this.#cursor = root.document.createElement("div");

    this.#cursor.ariaHidden = "true";
    this.#cursor.style.border = "2px dashed #1f1f1f";
    this.#cursor.style.outline = "2px dashed #f0f0f0";
    this.#cursor.style.minHeight = "4px";
    this.#cursor.style.minWidth = "4px";
    this.#cursor.style.position = "absolute";
    this.#cursor.style.left = "0px";
    this.#cursor.style.top = "0px";
    this.#cursor.style.margin = "0px";
    this.#cursor.style.padding = "2px";
    this.#cursor.style.pointerEvents = "none";
    this.#cursor.style.zIndex = "calc(Infinity)";
    this.#cursor.dataset.testid = "virtual-screen-reader-cursor";

    this.#container!.appendChild(this.#cursor);
  }

  #setActiveNode(accessibilityNode: AccessibilityNode) {
    this.#activeNode = accessibilityNode;

    if (!this.#cursor) {
      return;
    }

    const rect = getElementNode(accessibilityNode).getBoundingClientRect();

    this.#cursor.style.top = `${rect.top - 2}px`;
    this.#cursor.style.left = `${rect.left - 4}px`;
    this.#cursor.style.width = `${rect.width}px`;
    this.#cursor.style.height = `${rect.height}px`;
  }

  #getAccessibilityTree() {
    if (!this.#treeCache) {
      const tree = createAccessibilityTree(this.#container);

      this.#treeCache =
        this.#container && tree ? flattenTree(this.#container, tree, null) : [];
    }

    return this.#treeCache;
  }

  #getModalAccessibilityTree() {
    const tree = this.#getAccessibilityTree();

    if (!this.#activeNode) {
      return tree;
    }

    const isModal =
      this.#activeNode.parentDialog?.getAttribute("aria-modal") === "true";

    if (!isModal) {
      return tree;
    }

    /**
     * Assistive technologies MAY limit navigation to the modal element's
     * contents.
     *
     * REF: https://www.w3.org/TR/wai-aria-1.2/#aria-modal
     */
    return tree.filter(
      ({ parentDialog }) => this.#activeNode!.parentDialog === parentDialog
    );
  }

  #invalidateTreeCache() {
    this.#treeCache = null;
  }

  async #handleFocusChange({ target }: Event) {
    await tick();

    this.#invalidateTreeCache();
    const tree = this.#getAccessibilityTree();

    if (!tree.length) {
      return;
    }

    // We've covered the tree having no length so there should be at least one
    // matching node, but if not we will not update the state
    const newActiveNode = tree.find(({ node }) => node === target);

    if (!newActiveNode) {
      return;
    }

    this.#updateState(newActiveNode, true);
  }

  #focusActiveElement() {
    // Is only called following a null guard for `this.#activeNode`.

    const target = getElementNode(this.#activeNode!);
    target?.focus();
  }

  async #announceLiveRegions(mutations: MutationRecord[]) {
    await tick();

    const container = this.#container;

    mutations
      .map((mutation) =>
        getLiveSpokenPhrase({
          container,
          mutation,
        })
      )
      .filter(Boolean)
      .forEach((spokenPhrase) => {
        this.#spokenPhraseLog.push(spokenPhrase);
      });
  }

  #spokenPhraseLogWithoutLiveRegions() {
    return this.#spokenPhraseLog.filter(
      (spokenPhrase) =>
        !spokenPhrase.startsWith(LIVE.ASSERTIVE) &&
        !spokenPhrase.startsWith(LIVE.POLITE)
    );
  }

  #updateState(accessibilityNode: AccessibilityNode, ignoreIfNoChange = false) {
    /**
     * When the dialog is correctly labeled and focus is moved to an element
     * (often an interactive element, such as a button) inside the dialog,
     * screen readers should announce the dialog's accessible role, name and
     * optionally description, along with announcing the focused element.
     *
     * REF: https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Roles/dialog_role#possible_effects_on_user_agents_and_assistive_technology
     */
    if (
      accessibilityNode.parentDialog !== null &&
      accessibilityNode.parentDialog !== this.#activeNode?.parentDialog
    ) {
      // One of the few cases where you will get two logs for a single
      // interaction.
      //
      // We don't need to perform the `ignoreIfNoChange` check as this will
      // only fire if the parent dialog element has changed, and if that
      // happens we can be fairly confident that item under the virtual
      // cursor has changed.
      const tree = this.#getAccessibilityTree();
      const parentDialogNode = tree.find(
        ({ node }) => node === accessibilityNode.parentDialog
      )!;

      const spokenPhrase = getSpokenPhrase(parentDialogNode);
      const itemText = getItemText(parentDialogNode);

      this.#itemTextLog.push(itemText);
      this.#spokenPhraseLog.push(spokenPhrase);
    }

    this.#setActiveNode(accessibilityNode);

    const spokenPhrase = getSpokenPhrase(accessibilityNode);
    const itemText = getItemText(accessibilityNode);

    if (
      ignoreIfNoChange &&
      spokenPhrase === this.#spokenPhraseLogWithoutLiveRegions().at(-1) &&
      itemText === this.#itemTextLog.at(-1)
    ) {
      return;
    }

    this.#itemTextLog.push(itemText);
    this.#spokenPhraseLog.push(spokenPhrase);
  }

  async #refreshState(ignoreIfNoChange: boolean) {
    await tick();

    this.#invalidateTreeCache();
    const tree = this.#getAccessibilityTree();
    const currentIndex = this.#getCurrentIndexByNode(tree);

    // This only fires after keyboard like interactions, both of which null
    // guard the `this.#activeNode` so it stands that we should still be able
    // to find it in the tree.

    const newActiveNode = tree.at(currentIndex)!;

    this.#updateState(newActiveNode, ignoreIfNoChange);
  }

  #getCurrentIndex(tree: AccessibilityNode[]) {
    return tree.findIndex(
      ({
        accessibleDescription,
        accessibleName,
        accessibleValue,
        node,
        role,
        spokenRole,
      }) =>
        accessibleDescription === this.#activeNode?.accessibleDescription &&
        accessibleName === this.#activeNode?.accessibleName &&
        accessibleValue === this.#activeNode?.accessibleValue &&
        node === this.#activeNode?.node &&
        role === this.#activeNode?.role &&
        spokenRole === this.#activeNode?.spokenRole
    );
  }

  #getCurrentIndexByNode(tree: AccessibilityNode[]) {
    return tree.findIndex(({ node }) => node === this.#activeNode?.node);
  }

  /**
   * [API Reference](https://www.guidepup.dev/docs/api/class-virtual#virtual-active-node)
   *
   * Getter for the active node under the Virtual Screen Reader cursor.
   *
   * Note that this is not always the same as the currently focused node.
   *
   * ```ts
   * import { virtual } from "@guidepup/virtual-screen-reader";
   *
   * test("example test", async () => {
   *   // Start the Virtual Screen Reader.
   *   await virtual.start({ container: document.body });
   *
   *   // Move to the next element.
   *   await virtual.next();
   *
   *   // Log the currently focused node.
   *   console.log(virtual.activeNode);
   *
   *   // Stop the Virtual Screen Reader.
   *   await virtual.stop();
   * });
   * ```
   *
   * @returns {Node|null}
   */
  get activeNode() {
    return this.#activeNode?.node ?? null;
  }

  /**
   * [API Reference](https://www.guidepup.dev/docs/api/class-virtual#virtual-commands)
   *
   * Getter for all Virtual Screen Reader commands.
   *
   * Use with the `await virtual.perform(command)` command to invoke an action:
   *
   * ```ts
   * import { virtual } from "@guidepup/virtual-screen-reader";
   *
   * test("example test", async () => {
   *   // Start the Virtual Screen Reader.
   *   await virtual.start({ container: document.body });
   *
   *   // Perform action to move to the next landmark.
   *   await virtual.perform(virtual.commands.moveToNextLandmark);
   *
   *   // Stop the Virtual Screen Reader.
   *   await virtual.stop();
   * });
   * ```
   */
  get commands() {
    return Object.fromEntries<keyof VirtualCommands>(
      (Object.keys(commands) as (keyof VirtualCommands)[]).map(
        (command: keyof VirtualCommands) => [command, command]
      )
    ) as { [K in keyof VirtualCommands]: K };
  }

  /**
   * [API Reference](https://www.guidepup.dev/docs/api/class-virtual#virtual-detect)
   *
   * Detect whether the screen reader is supported for the current OS:
   *
   * - `true` for all OS
   *
   * ```ts
   * import { virtual } from "@guidepup/virtual-screen-reader";
   *
   * test("example test", async () => {
   *   const isVirtualSupportedScreenReader = await virtual.detect();
   *
   *   console.log(isVirtualSupportedScreenReader);
   * });
   * ```
   *
   * @returns {Promise<boolean>}
   */
  async detect() {
    return true;
  }

  /**
   * [API Reference](https://www.guidepup.dev/docs/api/class-virtual#virtual-default)
   *
   * Detect whether the screen reader is the default screen reader for the current OS.
   *
   * - `false` for all OS
   *
   * ```ts
   * import { virtual } from "@guidepup/virtual-screen-reader";
   *
   * test("example test", async () => {
   *   const isVirtualDefaultScreenReader = await virtual.default();
   *
   *   console.log(isVirtualDefaultScreenReader);
   * });
   * ```
   *
   * @returns {Promise<boolean>}
   */
  async default() {
    return false;
  }

  /**
   * [API Reference](https://www.guidepup.dev/docs/api/class-virtual#virtual-start)
   *
   * Turn the Virtual Screen Reader on.
   *
   * This must be called before any other Virtual command can be issued.
   *
   * ```ts
   * import { virtual } from "@guidepup/virtual-screen-reader";
   *
   * test("example test", async () => {
   *   // Start the Virtual Screen Reader on the entire page.
   *   await virtual.start({ container: document.body });
   *
   *   // ... perform some commands.
   *
   *   // Stop the Virtual Screen Reader.
   *   await virtual.stop();
   * });
   * ```
   *
   * @param {object} [options] Additional options.
   */
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore for non-TS users we default the container to `null` which
  // prompts the missing container error.
  async start(
    { container, displayCursor = false, window: root }: StartOptions = {
      container: null as never,
      displayCursor: false,
    }
  ) {
    if (!container) {
      throw new Error(ERR_VIRTUAL_MISSING_CONTAINER);
    }

    if (!root && typeof window !== "undefined") {
      root = window;
    }

    this.#container = container;

    if (displayCursor) {
      this.#createCursor(root);
    }

    this.#disconnectDOMObserver = observeDOM(
      root,
      container,
      (mutations: MutationRecord[]) => {
        this.#invalidateTreeCache();
        this.#announceLiveRegions(mutations);
      }
    );

    const tree = this.#getAccessibilityTree();

    if (!tree.length) {
      return;
    }

    this.#boundHandleFocusChange = this.#handleFocusChange.bind(this);

    this.#container.addEventListener("focusin", this.#boundHandleFocusChange);

    this.#updateState(tree[0]);

    return;
  }

  /**
   * [API Reference](https://www.guidepup.dev/docs/api/class-virtual#virtual-stop)
   *
   * Turn the Virtual Screen Reader off.
   *
   * Calling this method will clear any item text or spoken phrases collected by Virtual.
   *
   * ```ts
   * import { virtual } from "@guidepup/virtual-screen-reader";
   *
   * test("example test", async () => {
   *   // Start the Virtual Screen Reader.
   *   await virtual.start({ container: document.body });
   *
   *   // ... perform some commands.
   *
   *   // Stop the Virtual Screen Reader.
   *   await virtual.stop();
   * });
   * ```
   */
  async stop() {
    this.#disconnectDOMObserver?.();
    this.#container?.removeEventListener("focusin", this.#boundHandleFocusChange);
    this.#invalidateTreeCache();

    if (this.#cursor) {
      this.#container?.removeChild(this.#cursor);
      this.#cursor = null;
    }

    this.#activeNode = null;
    this.#container = null;
    this.#itemTextLog = [];
    this.#spokenPhraseLog = [];
    this.#boundHandleFocusChange = null;
    return;
  }

  /**
   * [API Reference](https://www.guidepup.dev/docs/api/class-virtual#virtual-previous)
   *
   * Move the screen reader cursor to the previous location.
   *
   * ```ts
   * import { virtual } from "@guidepup/virtual-screen-reader";
   *
   * test("example test", async () => {
   *   // Start the Virtual Screen Reader.
   *   await virtual.start({ container: document.body });
   *
   *   // Move to the previous item.
   *   await virtual.previous();
   *
   *   // Stop the Virtual Screen Reader.
   *   await virtual.stop();
   * });
   * ```
   */
  async previous() {
    this.#checkContainer();
    await tick();

    const tree = this.#getModalAccessibilityTree();

    if (!tree.length) {
      return;
    }

    const currentIndex = this.#getCurrentIndex(tree);
    const nextIndex = currentIndex === -1 ? 0 : currentIndex - 1;
    // We've covered the tree having no length so there must be at least one
    // index, and we ensure to zero-guard with the logic above.

    const newActiveNode = tree.at(nextIndex)!;

    this.#updateState(newActiveNode);

    return;
  }

  /**
   * [API Reference](https://www.guidepup.dev/docs/api/class-virtual#virtual-next)
   *
   * Move the screen reader cursor to the next location.
   *
   * ```ts
   * import { virtual } from "@guidepup/virtual-screen-reader";
   *
   * test("example test", async () => {
   *   // Start the Virtual Screen Reader.
   *   await virtual.start({ container: document.body });
   *
   *   // Move to the next item.
   *   await virtual.next();
   *
   *   // Stop the Virtual Screen Reader.
   *   await virtual.stop();
   * });
   * ```
   */
  async next() {
    this.#checkContainer();
    await tick();

    const tree = this.#getModalAccessibilityTree();

    if (!tree.length) {
      return;
    }

    const currentIndex = this.#getCurrentIndex(tree);
    const nextIndex =
      currentIndex === -1 || currentIndex === tree.length - 1
        ? 0
        : currentIndex + 1;
    // We've covered the tree having no length so there must be at least one
    // index, and we ensure to zero-guard with the logic above.

    const newActiveNode = tree.at(nextIndex)!;

    this.#updateState(newActiveNode);

    return;
  }

  /**
   * [API Reference](https://www.guidepup.dev/docs/api/class-virtual#virtual-act)
   *
   * Perform the default action for the item in the Virtual Screen Reader cursor.
   *
   * ```ts
   * import { virtual } from "@guidepup/virtual-screen-reader";
   *
   * test("example test", async () => {
   *   // Start the Virtual Screen Reader.
   *   await virtual.start({ container: document.body });
   *
   *   // Move to the next item.
   *   await virtual.next();
   *
   *   // Perform the default action for the item.
   *   await virtual.act();
   *
   *   // Stop the Virtual Screen Reader.
   *   await virtual.stop();
   * });
   * ```
   */
  async act() {
    this.#checkContainer();
    await tick();

    if (!this.#activeNode) {
      return;
    }

    const target = getElementNode(this.#activeNode);

    /**
     * The user agent SHOULD simulate a click on the DOM element which is
     * mapped to that accessible object.
     *
     * REF: https://www.w3.org/TR/core-aam-1.2/#mapping_actions
     */
    await userEvent.click(target, defaultUserEventOptions);

    return;
  }

  /**
   * [API Reference](https://www.guidepup.dev/docs/api/class-virtual#virtual-interact)
   *
   * No-op to provide same API across screen readers.
   *
   * The Virtual Screen Reader does not require users to perform an additional
   * command to interact with the item in the Virtual Screen Reader cursor.
   */
  async interact() {
    this.#checkContainer();

    return;
  }

  /**
   * [API Reference](https://www.guidepup.dev/docs/api/class-virtual#virtual-stop-interacting)
   *
   * No-op to provide same API across screen readers.
   *
   * The Virtual Screen Reader does not require users to perform an additional
   * command to interact with the item in the Virtual Screen Reader cursor.
   */
  async stopInteracting() {
    this.#checkContainer();

    return;
  }

  /**
   * [API Reference](https://www.guidepup.dev/docs/api/class-virtual#virtual-press)
   *
   * Press a key on the active item.
   *
   * `key` can specify the intended [keyboardEvent.key](https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/key)
   * value or a single character to generate the text for. A superset of the `key` values can be found
   * [on the MDN key values page](https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/key/Key_Values). Examples of the keys are:
   *
   * `F1` - `F20`, `Digit0` - `Digit9`, `KeyA` - `KeyZ`, `Backquote`, `Minus`, `Equal`, `Backslash`, `Backspace`, `Tab`,
   * `Delete`, `Escape`, `ArrowDown`, `End`, `Enter`, `Home`, `Insert`, `PageDown`, `PageUp`, `ArrowRight`, `ArrowUp`, etc.
   *
   * Following modification shortcuts are also supported: `Shift`, `Control`, `Alt`, `Meta` (OS permitting).
   *
   * Holding down `Shift` will type the text that corresponds to the `key` in the upper case.
   *
   * If `key` is a single character, it is case-sensitive, so the values `a` and `A` will generate different respective
   * texts.
   *
   * Shortcuts such as `key: "Control+f"` or `key: "Control+Shift+f"` are supported as well. When specified with the
   * modifier, modifier is pressed and being held while the subsequent key is being pressed.
   *
   * ```ts
   * import { virtual } from "@guidepup/virtual-screen-reader";
   *
   * test("example test", async () => {
   *   // Start the Virtual Screen Reader.
   *   await virtual.start({ container: document.body });
   *
   *   // Open a find text modal.
   *   await virtual.press("Command+f");
   *
   *   // Stop the Virtual Screen Reader.
   *   await virtual.stop();
   * });
   * ```
   *
   * @param {string} key Name of the key to press or a character to generate, such as `ArrowLeft` or `a`.
   */
  async press(key: string) {
    this.#checkContainer();
    await tick();

    if (!this.#activeNode) {
      return;
    }

    const rawKeys = key.replace(/{/g, "{{").replace(/\[/g, "[[").split("+");
    const modifiers: string[] = [];
    const keys: string[] = [];

    rawKeys.forEach((rawKey) => {
      if (
        typeof MacOSModifiers[rawKey] !== "undefined" ||
        typeof WindowsModifiers[rawKey] !== "undefined"
      ) {
        modifiers.push(rawKey);
      } else {
        keys.push(rawKey);
      }
    });

    const keyboardCommand = [
      ...modifiers.map((modifier) => `{${modifier}>}`),
      ...keys.map((key) => `{${key}}`),
      ...modifiers.reverse().map((modifier) => `{/${modifier}}`),
    ].join("");

    this.#focusActiveElement();
    await userEvent.keyboard(keyboardCommand, defaultUserEventOptions);
    await this.#refreshState(true);

    return;
  }

  /**
   * [API Reference](https://www.guidepup.dev/docs/api/class-virtual#virtual-type)
   *
   * Type text into the active item.
   *
   * To press a special key, like `Control` or `ArrowDown`, use `virtual.press(key)`.
   *
   * ```ts
   * import { virtual } from "@guidepup/virtual-screen-reader";
   *
   * test("example test", async () => {
   *   // Start the Virtual Screen Reader.
   *   await virtual.start({ container: document.body });
   *
   *   // Type a username and key Enter.
   *   await virtual.type("my-username");
   *   await virtual.press("Enter");
   *
   *   // Stop the Virtual Screen Reader.
   *   await virtual.stop();
   * });
   * ```
   *
   * @param {string} text Text to type into the active item.
   */
  async type(text: string) {
    this.#checkContainer();
    await tick();

    if (!this.#activeNode) {
      return;
    }

    const target = getElementNode(this.#activeNode);
    await userEvent.type(target, text, defaultUserEventOptions);
    await this.#refreshState(true);

    return;
  }

  /**
   * [API Reference](https://www.guidepup.dev/docs/api/class-virtual#virtual-perform)
   *
   * Perform a Virtual Screen Reader command.
   *
   * ```ts
   * import { virtual } from "@guidepup/virtual-screen-reader";
   *
   * test("example test", async () => {
   *   // Start the Virtual Screen Reader.
   *   await virtual.start({ container: document.body });
   *
   *   // Perform action to move to the next landmark.
   *   await virtual.perform(virtual.commands.moveToNextLandmark);
   *
   *   // Stop the Virtual Screen Reader.
   *   await virtual.stop();
   * });
   * ```
   *
   * @param {string} command Screen reader command.
   * @param {object} [options] Command options.
   */
  async perform<
    T extends keyof VirtualCommands,
    K extends Omit<Parameters<VirtualCommands[T]>[0], keyof VirtualCommandArgs>
  >(command: T, options?: { [L in keyof K]: K[L] }) {
    this.#checkContainer();
    await tick();

    const tree = this.#getModalAccessibilityTree();

    if (!tree.length) {
      return;
    }

    const currentIndex = this.#getCurrentIndex(tree);
    const nextIndex = commands[command]?.({
      ...options,
      // `this.#checkContainer();` above null guards us here.

      container: this.#container!,
      currentIndex,
      tree,
    });

    if (typeof nextIndex !== "number") {
      return;
    }

    // We know the tree has length, and we guard against the command not being
    // able to find an index in the tree so we are fine.

    const newActiveNode = tree.at(nextIndex)!;
    this.#updateState(newActiveNode);

    return;
  }

  /**
   * [API Reference](https://www.guidepup.dev/docs/api/class-virtual#virtual-click)
   *
   * Click the mouse.
   *
   * ```ts
   * import { virtual } from "@guidepup/virtual-screen-reader";
   *
   * test("example test", async () => {
   *   // Start the Virtual Screen Reader.
   *   await virtual.start({ container: document.body });
   *
   *   // Left-click the mouse.
   *   await virtual.click();
   *
   *   // Left-click the mouse using specific options.
   *   await virtual.click({ button: "left", clickCount: 1 });
   *
   *   // Double-right-click the mouse.
   *   await virtual.click({ button: "right", clickCount: 2 });
   *
   *   // Stop the Virtual Screen Reader.
   *   await virtual.stop();
   * });
   * ```
   *
   * @param {object} [options] Click options.
   */
  async click({ button = "left", clickCount = 1 } = {}) {
    this.#checkContainer();
    await tick();

    if (!this.#activeNode) {
      return;
    }

    const key = `[Mouse${button[0].toUpperCase()}${button.slice(1)}]`;
    const keys = key.repeat(clickCount);
    const target = getElementNode(this.#activeNode);

    await userEvent.pointer(
      [{ target }, { keys, target }],
      defaultUserEventOptions
    );

    return;
  }

  /**
   * [API Reference](https://www.guidepup.dev/docs/api/class-virtual#virtual-last-spoken-phrase)
   *
   * Get the last spoken phrase.
   *
   * ```ts
   * import { virtual } from "@guidepup/virtual-screen-reader";
   *
   * test("example test", async () => {
   *   // Start the Virtual Screen Reader.
   *   await virtual.start({ container: document.body });
   *
   *   // Move to the next item.
   *   await virtual.next();
   *
   *   // Get the phrase spoken by the Virtual Screen Reader from moving to the next item above.
   *   const lastSpokenPhrase = await virtual.lastSpokenPhrase();
   *   console.log(lastSpokenPhrase);
   *
   *   // Stop the Virtual Screen Reader.
   *   await virtual.stop();
   * });
   * ```
   *
   * @returns {Promise<string>} The last spoken phrase.
   */
  async lastSpokenPhrase() {
    this.#checkContainer();
    await tick();

    return this.#spokenPhraseLog.at(-1) ?? "";
  }

  /**
   * [API Reference](https://www.guidepup.dev/docs/api/class-virtual#virtual-item-text)
   *
   * Get the text of the item in the Virtual Screen Reader cursor.
   *
   * ```ts
   * import { virtual } from "@guidepup/virtual-screen-reader";
   *
   * test("example test", async () => {
   *   // Start the Virtual Screen Reader.
   *   await virtual.start({ container: document.body });
   *
   *   // Move to the next item.
   *   await virtual.next();
   *
   *   // Get the text (if any) for the item currently in focus by the Virtual
   *   // screen reader cursor.
   *   const itemText = await virtual.itemText();
   *   console.log(itemText);
   *
   *   // Stop the Virtual Screen Reader.
   *   await virtual.stop();
   * });
   * ```
   *
   * @returns {Promise<string>} The item's text.
   */
  async itemText() {
    this.#checkContainer();
    await tick();

    return this.#itemTextLog.at(-1) ?? "";
  }

  /**
   * [API Reference](https://www.guidepup.dev/docs/api/class-virtual#virtual-spoken-phrase-log)
   *
   * Get the log of all spoken phrases for this Virtual Screen Reader instance.
   *
   * ```ts
   * import { virtual } from "@guidepup/virtual-screen-reader";
   *
   * test("example test", async () => {
   *   // Start the Virtual Screen Reader.
   *   await virtual.start({ container: document.body });
   *
   *   // Move through several items.
   *   for (let i = 0; i < 10; i++) {
   *     await virtual.next();
   *   }
   *
   *   // Get the phrase spoken by the Virtual Screen Reader from moving through the
   *   // items above.
   *   const spokenPhraseLog = await virtual.spokenPhraseLog();
   *   console.log(spokenPhraseLog);
   *
   *   // Stop the Virtual Screen Reader.
   *   await virtual.stop();
   * });
   * ```
   *
   * @returns {Promise<string[]>} The spoken phrase log.
   */
  async spokenPhraseLog() {
    this.#checkContainer();

    await tick();

    return this.#spokenPhraseLog;
  }

  /**
   * [API Reference](https://www.guidepup.dev/docs/api/class-virtual#virtual-item-text-log)
   *
   * Get the log of all visited item text for this Virtual Screen Reader instance.
   *
   * ```ts
   * import { virtual } from "@guidepup/virtual-screen-reader";
   *
   * test("example test", async () => {
   *   // Start the Virtual Screen Reader.
   *   await virtual.start({ container: document.body });
   *
   *   // Move through several items.
   *   for (let i = 0; i < 10; i++) {
   *     await virtual.next();
   *   }
   *
   *   // Get the text (if any) for all the items visited by the Virtual screen
   *   // reader cursor.
   *   const itemTextLog = await virtual.itemTextLog();
   *   console.log(itemTextLog);
   *
   *   // Stop the Virtual Screen Reader.
   *   await virtual.stop();
   * });
   * ```
   *
   * @returns {Promise<string[]>} The item text log.
   */
  async itemTextLog() {
    this.#checkContainer();

    await tick();

    return this.#itemTextLog;
  }

  /**
   * [API Reference](https://www.guidepup.dev/docs/api/class-virtual#virtual-clear-spoken-phrase-log)
   *
   * Clear the log of all spoken phrases for this Virtual Screen Reader
   * instance.
   *
   * ```ts
   * import { virtual } from "@guidepup/virtual-screen-reader";
   *
   * test("example test", async () => {
   *   // Start the Virtual Screen Reader.
   *   await virtual.start({ container: document.body });
   *
   *   // ... perform some commands.
   *
   *   // Clear the spoken phrase log.
   *   await virtual.clearSpokenPhraseLog();
   *
   *   // Stop the Virtual Screen Reader.
   *   await virtual.stop();
   * });
   * ```
   */
  async clearSpokenPhraseLog() {
    this.#checkContainer();

    await tick();

    this.#spokenPhraseLog = [];
  }

  /**
   * [API Reference](https://www.guidepup.dev/docs/api/class-virtual#virtual-clear-item-text-log)
   *
   * Clear the log of all visited item text for this Virtual Screen Reader
   * instance.
   *
   * ```ts
   * import { virtual } from "@guidepup/virtual-screen-reader";
   *
   * test("example test", async () => {
   *   // Start the Virtual Screen Reader.
   *   await virtual.start({ container: document.body });
   *
   *   // ... perform some commands.
   *
   *   // Clear the item text log.
   *   await virtual.clearItemTextLog();
   *
   *   // Stop the Virtual Screen Reader.
   *   await virtual.stop();
   * });
   * ```
   */
  async clearItemTextLog() {
    this.#checkContainer();

    await tick();

    this.#itemTextLog = [];
  }
}

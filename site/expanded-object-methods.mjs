// A method inside an expanded object prints as a method.
//
// `expandObjects` in `typedoc.jsonc` is what makes the block above an object type print its
// members rather than the word `object`. It cannot be set on its own. The plugin renders each
// member as `name: <type>` and takes that type from `helpers.getDeclarationType`, which for a
// member carrying signatures answers the *return type of the first one*. So the parameters
// disappear and a method prints as a property holding its own return value: `run(prompt:
// RunPrompt): Promise<RunOutcome>` becomes `run: Promise<RunOutcome>`, and `tx<T>(body: ...):
// Promise<T>` becomes `tx: Promise<T>` with `T` bound to nothing at all. About forty members
// across the eight pages, concentrated in the types most people read. `object` said nothing and
// misled nobody; that block would mislead, which is why the setting and this file arrive
// together.
//
// The fix is one widening: inside an expanded object, hand the renderer the member's own function
// type instead of its return type. `someType` renders a `ReflectionType` over a declaration with
// exactly one signature as `(param) => Return`, type parameters included, which is the line
// wanted.
//
// **Two things it has to get right.**
//
// It applies only inside an expanded object. The Properties and Methods sections below the block
// call the same helper for the part after the colon, and they print the name and the parameters
// themselves, so a widening that applied everywhere would print the parameters twice.
//
// And an expanded object can contain another one, so "inside" is a count and not a flag. Flipped,
// an inner object would switch the helper back off on its way out and its parent's remaining
// members would go back to printing return types.
//
// **On what this reads out of the render context.** Two names, `partials.declarationType` and
// `helpers.getDeclarationType`. A future `typedoc-plugin-markdown` that renames either one, or
// that stops asking the helper for a member's type, leaves the widening wired to nothing and the
// methods go quietly back to printing their return type. Nothing here guards against that on
// purpose: `check:docs` regenerates the reference and diffs it against what is committed on every
// CI run, so the generation that changed fails and names the pages that moved. That is what
// committing the reference buys, and it is the reason not to add a guard here.

import { ReflectionType } from "typedoc";
import { MarkdownTheme, MarkdownThemeContext } from "typedoc-plugin-markdown";

class ExpandedObjectContext extends MarkdownThemeContext {
  constructor(theme, page, options) {
    super(theme, page, options);

    // How many expanded objects the renderer is currently inside. The base class initialises
    // `partials` and `helpers` as its own fields, which run during `super()` above, so both are
    // in place to be wrapped here.
    let depth = 0;

    const expandedObject = this.partials.declarationType;
    this.partials.declarationType = (model, partialOptions) => {
      depth += 1;
      try {
        return expandedObject(model, partialOptions);
      } finally {
        depth -= 1;
      }
    };

    const memberType = this.helpers.getDeclarationType;
    this.helpers.getDeclarationType = (model) =>
      depth > 0 && model.signatures?.length ? new ReflectionType(model) : memberType(model);
  }
}

/**
 * The theme the widening is installed through. Defining one is the mechanism: a render context is
 * built per page by `getRenderContext`, and overriding that method is how the plugin gets to
 * return a context of its own.
 */
class ExpandedObjectTheme extends MarkdownTheme {
  getRenderContext(page) {
    return new ExpandedObjectContext(this, page, this.application.options);
  }
}

/** @param {import("typedoc").Application} app */
export function load(app) {
  app.renderer.defineTheme("expanded-objects", ExpandedObjectTheme);
}

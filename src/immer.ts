import {createES5Proxy, willFinalizeES5, markChangedES5} from "./es5"
import {createProxy, markChanged} from "./proxy"

import {applyPatches, generatePatches} from "./patches"
import {
	assign,
	each,
	has,
	is,
	isDraft,
	isSet,
	get,
	isMap,
	isDraftable,
	isEnumerable,
	shallowCopy,
	DRAFT_STATE,
	NOTHING,
	freeze,
	isPlainObject,
	DRAFTABLE
} from "./common"
import {ImmerScope} from "./scope"
import {
	ImmerState,
	IProduce,
	IProduceWithPatches,
	Objectish,
	PatchListener,
	Draft,
	Patch,
	Drafted
} from "./types"
import {proxyMap} from "./map"
import {proxySet} from "./set"

function verifyMinified() {}

const configDefaults = {
	useProxies:
		typeof Proxy !== "undefined" &&
		typeof Proxy.revocable !== "undefined" &&
		typeof Reflect !== "undefined",
	autoFreeze:
		typeof process !== "undefined"
			? process.env.NODE_ENV !== "production"
			: verifyMinified.name === "verifyMinified",
	onAssign: null,
	onDelete: null,
	onCopy: null
}

interface ProducersFns {
	produce: IProduce
	produceWithPatches: IProduceWithPatches
}

export class Immer implements ProducersFns {
	useProxies: boolean = false
	autoFreeze: boolean = false
	onAssign?: (state: ImmerState, prop: string | number, value: unknown) => void
	onDelete?: (state: ImmerState, prop: string | number) => void
	onCopy?: (state: ImmerState) => void

	constructor(config?: {
		useProxies?: boolean
		autoFreeze?: boolean
		onAssign?: (
			state: ImmerState,
			prop: string | number,
			value: unknown
		) => void
		onDelete?: (state: ImmerState, prop: string | number) => void
		onCopy?: (state: ImmerState) => void
	}) {
		assign(this, configDefaults, config)
		this.setUseProxies(this.useProxies)
		this.produce = this.produce.bind(this)
		this.produceWithPatches = this.produceWithPatches.bind(this)
	}

	/**
	 * The `produce` function takes a value and a "recipe function" (whose
	 * return value often depends on the base state). The recipe function is
	 * free to mutate its first argument however it wants. All mutations are
	 * only ever applied to a __copy__ of the base state.
	 *
	 * Pass only a function to create a "curried producer" which relieves you
	 * from passing the recipe function every time.
	 *
	 * Only plain objects and arrays are made mutable. All other objects are
	 * considered uncopyable.
	 *
	 * Note: This function is __bound__ to its `Immer` instance.
	 *
	 * @param {any} base - the initial state
	 * @param {Function} producer - function that receives a proxy of the base state as first argument and which can be freely modified
	 * @param {Function} patchListener - optional function that will be called with all the patches produced here
	 * @returns {any} a new state, or the initial state if nothing was modified
	 */
	produce(base, recipe?, patchListener?) {
		// curried invocation
		if (typeof base === "function" && typeof recipe !== "function") {
			const defaultBase = recipe
			recipe = base

			const self = this
			return function curriedProduce(this: any, base = defaultBase, ...args) {
				return self.produce(base, draft => recipe.call(this, draft, ...args)) // prettier-ignore
			}
		}

		// prettier-ignore
		{
			if (typeof recipe !== "function") {
				throw new Error("The first or second argument to `produce` must be a function")
			}
			if (patchListener !== undefined && typeof patchListener !== "function") {
				throw new Error("The third argument to `produce` must be a function or undefined")
			}
		}

		let result

		// Only plain objects, arrays, and "immerable classes" are drafted.
		if (isDraftable(base)) {
			const scope = ImmerScope.enter(this)
			const proxy = this.createProxy(base, undefined)
			let hasError = true
			try {
				result = recipe(proxy)
				hasError = false
			} finally {
				// finally instead of catch + rethrow better preserves original stack
				if (hasError) scope.revoke()
				else scope.leave()
			}
			if (typeof Promise !== "undefined" && result instanceof Promise) {
				return result.then(
					result => {
						scope.usePatches(patchListener)
						return this.processResult(result, scope)
					},
					error => {
						scope.revoke()
						throw error
					}
				)
			}
			scope.usePatches(patchListener)
			return this.processResult(result, scope)
		} else {
			result = recipe(base)
			if (result === NOTHING) return undefined
			if (result === undefined) result = base
			this.maybeFreeze(result, true)
			return result
		}
	}

	produceWithPatches(arg1, arg2?, arg3?): any {
		if (typeof arg1 === "function") {
			const self = this
			return (state, ...args) =>
				this.produceWithPatches(state, draft => arg1(draft, ...args))
		}
		// non-curried form
		if (arg3)
			throw new Error("A patch listener cannot be passed to produceWithPatches")
		let patches, inversePatches
		const nextState = this.produce(arg1, arg2, (p, ip) => {
			patches = p
			inversePatches = ip
		})
		return [nextState, patches, inversePatches]
	}

	createDraft<T extends Objectish>(base: T): Draft<T> {
		if (!isDraftable(base)) {
			throw new Error("First argument to `createDraft` must be a plain object, an array, or an immerable object") // prettier-ignore
		}
		const scope = ImmerScope.enter(this)
		const proxy = this.createProxy(base, undefined)
		proxy[DRAFT_STATE].isManual = true
		scope.leave()
		return proxy as any
	}

	finishDraft<D extends Draft<any>>(
		draft: D,
		patchListener: PatchListener
	): D extends Draft<infer T> ? T : never {
		const state = draft && draft[DRAFT_STATE]
		if (!state || !state.isManual) {
			throw new Error("First argument to `finishDraft` must be a draft returned by `createDraft`") // prettier-ignore
		}
		if (state.finalized) {
			throw new Error("The given draft is already finalized") // prettier-ignore
		}
		const {scope} = state
		scope.usePatches(patchListener)
		return this.processResult(undefined, scope)
	}

	/**
	 * Pass true to automatically freeze all copies created by Immer.
	 *
	 * By default, auto-freezing is disabled in production.
	 */
	setAutoFreeze(value: boolean) {
		this.autoFreeze = value
	}

	/**
	 * Pass true to use the ES2015 `Proxy` class when creating drafts, which is
	 * always faster than using ES5 proxies.
	 *
	 * By default, feature detection is used, so calling this is rarely necessary.
	 */
	setUseProxies(value: boolean) {
		this.useProxies = value
	}

	applyPatches(base: Objectish, patches: Patch[]) {
		// If a patch replaces the entire state, take that replacement as base
		// before applying patches
		let i
		for (i = patches.length - 1; i >= 0; i--) {
			const patch = patches[i]
			if (patch.path.length === 0 && patch.op === "replace") {
				base = patch.value
				break
			}
		}

		if (isDraft(base)) {
			// N.B: never hits if some patch a replacement, patches are never drafts
			return applyPatches(base, patches)
		}
		// Otherwise, produce a copy of the base state.
		return this.produce(base, draft =>
			applyPatches(draft, patches.slice(i + 1))
		)
	}

	/** @internal */
	processResult(result: any, scope: ImmerScope) {
		const baseDraft = scope.drafts![0]
		const isReplaced = result !== undefined && result !== baseDraft
		this.willFinalize(scope, result, isReplaced)
		if (isReplaced) {
			if (baseDraft[DRAFT_STATE].modified) {
				scope.revoke()
				throw new Error("An immer producer returned a new value *and* modified its draft. Either return a new value *or* modify the draft.") // prettier-ignore
			}
			if (isDraftable(result)) {
				// Finalize the result in case it contains (or is) a subset of the draft.
				result = this.finalize(result, null, scope)
				this.maybeFreeze(result)
			}
			if (scope.patches) {
				scope.patches.push({
					op: "replace",
					path: [],
					value: result
				})
				scope.inversePatches!.push({
					op: "replace",
					path: [],
					value: baseDraft[DRAFT_STATE].base
				})
			}
		} else {
			// Finalize the base draft.
			result = this.finalize(baseDraft, [], scope)
		}
		scope.revoke()
		if (scope.patches) {
			scope.patchListener!(scope.patches, scope.inversePatches!)
		}
		return result !== NOTHING ? result : undefined
	}

	createProxy<T>(value: any, parent?: ImmerState) {
		if (!value || typeof value !== "object") return value

		let draft: Drafted

		if (
			isPlainObject(value) ||
			Array.isArray(value) ||
			value[DRAFTABLE] ||
			value?.constructor?.[DRAFTABLE]
		) {
			draft = this.useProxies
				? createProxy(value, parent)
				: createES5Proxy(value, parent)
		} else if (isMap(value)) draft = proxyMap(value, parent)
		else if (isSet(value)) draft = proxySet(value, parent)
		else return value

		const scope = parent ? parent.scope : ImmerScope.current!
		scope.drafts.push(draft)
		return draft
	}

	willFinalize(scope: ImmerScope, thing: any, isReplaced: boolean) {
		if (!this.useProxies) willFinalizeES5(scope, thing, isReplaced)
	}

	markChanged(state: any) {
		if (this.useProxies) {
			markChanged(state)
		} else {
			markChangedES5(state)
		}
	}

	/**
	 * @internal
	 * Finalize a draft, returning either the unmodified base state or a modified
	 * copy of the base state.
	 */
	finalize(draft: any, path: string[] | null, scope: ImmerScope) {
		const state = draft[DRAFT_STATE]
		if (!state) {
			if (Object.isFrozen(draft)) return draft
			return this.finalizeTree(draft, null, scope)
		}
		// Never finalize drafts owned by another scope.
		if (state.scope !== scope) {
			return draft
		}
		if (!state.modified) {
			this.maybeFreeze(state.base, true)
			return state.base
		}
		if (!state.finalized) {
			state.finalized = true
			this.finalizeTree(state.draft, path, scope)

			// We cannot really delete anything inside of a Set. We can only replace the whole Set.
			if (this.onDelete && !isSet(state.base)) {
				// The `assigned` object is unreliable with ES5 drafts.
				if (this.useProxies) {
					const {assigned} = state
					each(assigned, (prop, exists) => {
						if (!exists) this.onDelete?.(state, prop as any)
					})
				} else {
					// TODO: Figure it out for Maps and Sets if we need to support ES5
					const {base, copy} = state
					each(base, prop => {
						if (!has(copy, prop)) this.onDelete?.(state, prop as any)
					})
				}
			}
			if (this.onCopy) {
				this.onCopy(state)
			}

			// At this point, all descendants of `state.copy` have been finalized,
			// so we can be sure that `scope.canAutoFreeze` is accurate.
			if (this.autoFreeze && scope.canAutoFreeze) {
				freeze(state.copy, false)
			}

			if (path && scope.patches) {
				generatePatches(state, path, scope.patches, scope.inversePatches!)
			}
		}
		return state.copy
	}

	/**
	 * @internal
	 * Finalize all drafts in the given state tree.
	 */
	finalizeTree(root: any, rootPath: string[] | null, scope: ImmerScope) {
		const state = root[DRAFT_STATE]
		if (state) {
			// TODO: remove crap
			// if (state.modified && !state.copy) {
			// 	state.copy = shallowCopy(state.base, false)
			// }
			// else
			if (!this.useProxies && !isMap(root) && !isSet(root)) {
				// Create the final copy, with added keys and without deleted keys.
				state.copy = shallowCopy(state.draft, true) // TODO: optimization, can we get rid of this and just use state.copy?
			}

			root = state.copy
		}

		const needPatches = !!rootPath && !!scope.patches
		const finalizeProperty = (prop, value, parent) => {
			if (value === parent) {
				throw Error("Immer forbids circular references")
			}

			// In the `finalizeTree` method, only the `root` object may be a draft.
			const isDraftProp = !!state && parent === root
			const isSetMember = isSet(parent)

			if (isDraft(value)) {
				const path =
					isDraftProp &&
					needPatches &&
					!isSetMember && // Set objects are atomic since they have no keys.
					!has(state.assigned, prop) // Skip deep patches for assigned keys.
						? rootPath!.concat(prop)
						: null

				// Drafts owned by `scope` are finalized here.
				value = this.finalize(value, path, scope)
				replace(parent, prop, value)

				// Drafts from another scope must prevent auto-freezing.
				if (isDraft(value)) {
					scope.canAutoFreeze = false
				}

				// Unchanged drafts are never passed to the `onAssign` hook.
				// if (isDraftProp && !isSet && value === get(state.base, prop)) return
			}
			// Unchanged draft properties are ignored.
			else if (isDraftProp && is(value, get(state.base, prop))) {
				return
			}
			// Search new objects for unfinalized drafts. Frozen objects should never contain drafts.
			else if (isDraftable(value) && !Object.isFrozen(value)) {
				each(value, finalizeProperty)
				this.maybeFreeze(value)
			}

			if (isDraftProp && this.onAssign && !isSetMember) {
				this.onAssign(state, prop, value)
			}
		}

		each(root, finalizeProperty)
		return root
	}
	maybeFreeze(value, deep = false) {
		if (this.autoFreeze && !isDraft(value)) {
			freeze(value, deep)
		}
	}
}

function replace(parent, prop, value) {
	if (isMap(parent)) {
		parent.set(prop, value)
	} else if (isSet(parent)) {
		// In this case, the `prop` is actually a draft.
		parent.delete(prop)
		parent.add(value)
	} else if (Array.isArray(parent) || isEnumerable(parent, prop)) {
		// Preserve non-enumerable properties.
		parent[prop] = value
	} else {
		Object.defineProperty(parent, prop, {
			value,
			writable: true,
			configurable: true
		})
	}
}
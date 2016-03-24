import { capture } from '../global/capture';
import Promise from '../utils/Promise';
import { isEqual, isNumeric } from '../utils/is';
import { removeFromArray } from '../utils/array';
import { handleChange, mark, teardown } from '../shared/methodCallers';
import Ticker from '../shared/Ticker';
import getPrefixer from './helpers/getPrefixer';
import { isArray, isObject } from '../utils/is';
import KeyModel from './specials/KeyModel';
import KeypathModel from './specials/KeypathModel';
import { escapeKey, unescapeKey } from '../shared/keypaths';

const hasProp = Object.prototype.hasOwnProperty;

function updateFromBindings ( model ) {
	model.updateFromBindings( true );
}

function updateKeypathDependants ( model ) {
	model.updateKeypathDependants();
}

let originatingModel = null;

export default class Model {
	constructor ( parent, key ) {
		this.deps = [];

		this.children = [];
		this.childByKey = {};

		this.indexModels = [];

		this.unresolved = [];
		this.unresolvedByKey = {};

		this.bindings = [];

		this.value = undefined;

		this.ticker = null;

		if ( parent ) {
			this.parent = parent;
			this.root = parent.root;
			this.key = unescapeKey( key );
			this.isReadonly = parent.isReadonly;

			const parentValue = parent.get();

			if ( parentValue ) {
				this.value = parentValue[ this.key ];
				this.adapt();
			}
		}
	}

	adapt () {
		const adaptors = this.root.adaptors;
		const len = adaptors.length;

		// Exit early if no adaptors
		if ( len === 0 ) return;

		const value = this.value;

		// TODO remove this legacy nonsense
		const ractive = this.root.ractive;
		const keypath = this.getKeypath();

		let i;

		for ( i = 0; i < len; i += 1 ) {
			const adaptor = adaptors[i];
			if ( adaptor.filter( value, keypath, ractive ) ) {
				this.wrapper = adaptor.wrap( ractive, value, keypath, getPrefixer( keypath ) );
				this.wrapper.value = this.value;
				this.wrapper.__model = this; // massive temporary hack to enable array adaptor

				this.value = this.wrapper.get();

				break;
			}
		}
	}

	addUnresolved ( key, resolver ) {
		if ( !this.unresolvedByKey[ key ] ) {
			this.unresolved.push( key );
			this.unresolvedByKey[ key ] = [];
		}

		this.unresolvedByKey[ key ].push( resolver );
	}

	animate ( from, to, options, interpolator ) {
		if ( this.ticker ) this.ticker.stop();

		let fulfilPromise;
		const promise = new Promise( fulfil => fulfilPromise = fulfil );

		this.ticker = new Ticker({
			duration: options.duration,
			easing: options.easing,
			step: t => {
				const value = interpolator( t );
				this.applyValue( value );
				if ( options.step ) options.step( t, value );
			},
			complete: () => {
				this.applyValue( to );
				if ( options.complete ) options.complete( to );

				this.ticker = null;
				fulfilPromise();
			}
		});

		promise.stop = this.ticker.stop;
		return promise;
	}

	applyValue ( value ) {
		if ( isEqual( value, this.value ) ) return;

		// TODO deprecate this nonsense
		this.root.changes[ this.getKeypath() ] = value;

		if ( this.parent.wrapper && this.parent.wrapper.set ) {
			this.parent.wrapper.set( this.key, value );
			this.parent.value = this.parent.wrapper.get();

			this.value = this.parent.value[ this.key ];
			// TODO should this value be adapted? probably
		} else if ( this.wrapper ) {
			const shouldTeardown = !this.wrapper.reset || this.wrapper.reset( value ) === false;

			if ( shouldTeardown ) {
				this.wrapper.teardown();
				this.wrapper = null;
				this.parent.value[ this.key ] = this.value = value;
				this.adapt();
			} else {
				this.value = this.wrapper.get();
			}
		} else {
			const parentValue = this.parent.value || this.parent.createBranch( this.key );
			parentValue[ this.key ] = value;

			this.value = value;
			this.adapt();
		}

		this.parent.clearUnresolveds();
		this.clearUnresolveds();

		// notify dependants
		const previousOriginatingModel = originatingModel; // for the array.length special case
		originatingModel = this;

		this.children.forEach( mark );
		this.deps.forEach( handleChange );

		let parent = this.parent;
		while ( parent ) {
			parent.deps.forEach( handleChange );
			parent = parent.parent;
		}

		originatingModel = previousOriginatingModel;
	}

	clearUnresolveds ( specificKey ) {
		let i = this.unresolved.length;

		while ( i-- ) {
			const key = this.unresolved[i];

			if ( specificKey && key !== specificKey ) continue;

			const resolvers = this.unresolvedByKey[ key ];
			const hasKey = this.has( key );

			let j = resolvers.length;
			while ( j-- ) {
				if ( hasKey ) resolvers[j].attemptResolution();
				if ( resolvers[j].resolved ) resolvers.splice( j, 1 );
			}

			if ( !resolvers.length ) {
				this.unresolved.splice( i, 1 );
				this.unresolvedByKey[ key ] = null;
			}
		}
	}

	createBranch ( key ) {
		const branch = isNumeric( key ) ? [] : {};
		this.set( branch );

		return branch;
	}

	findMatches ( keys ) {
		const len = keys.length;

		let existingMatches = [ this ];
		let matches;
		let i;

		for ( i = 0; i < len; i += 1 ) {
			const key = keys[i];

			if ( key === '*' ) {
				matches = [];
				existingMatches.forEach( model => {
					matches.push.apply( matches, model.getValueChildren( model.get() ) );
				});
			} else {
				matches = existingMatches.map( model => model.joinKey( key ) );
			}

			existingMatches = matches;
		}

		return matches;
	}

	get ( shouldCapture ) {
		if ( shouldCapture ) capture( this );
		return this.value;
	}

	getIndexModel ( fragmentIndex ) {
		const indexModels = this.parent.indexModels;

		// non-numeric keys are a special of a numeric index in a object iteration
		if ( typeof this.key === 'string' && fragmentIndex !== undefined ) {
			return new KeyModel( fragmentIndex );
		} else if ( !indexModels[ this.key ] ) {
			indexModels[ this.key ] = new KeyModel( this.key );
		}

		return indexModels[ this.key ];
	}

	getKeyModel () {
		// TODO... different to IndexModel because key can never change
		return new KeyModel( escapeKey( this.key ) );
	}

	getKeypathModel ( ractive ) {
		let keypath = this.getKeypath(), model = this.keypathModel || ( this.keypathModel = new KeypathModel( this ) );

		if ( ractive && ractive.component ) {
			let mapped = this.getKeypath( ractive );
			if ( mapped !== keypath ) {
				let map = ractive.viewmodel.keypathModels || ( ractive.viewmodel.keypathModels = {} );
				let child = map[ keypath ] || ( map[ keypath ] = new KeypathModel( this, ractive ) );
				model.addChild( child );
				return child;
			}
		}

		return model;
	}

	getKeypath ( ractive ) {
		let root = this.parent.isRoot ? escapeKey( this.key ) : this.parent.getKeypath() + '.' + escapeKey( this.key );

		if ( ractive && ractive.component ) {
			let map = ractive.viewmodel.mappings;
			for ( let k in map ) {
				if ( root.indexOf( map[ k ].getKeypath() ) >= 0 ) {
					root = root.replace( map[ k ].getKeypath(), k );
					break;
				}
			}
		}

		return root;
	}

	getValueChildren ( value ) {

		let children;
		if ( isArray( value ) ) {
			children = [];
			// special case - array.length. This is a horrible kludge, but
			// it'll do for now. Alternatives welcome
			if ( originatingModel && originatingModel.parent === this && originatingModel.key === 'length' ) {
				children.push( originatingModel );
			}
			value.forEach( ( m, i ) => {
				children.push( this.joinKey( i ) );
			});

		}

		else if ( isObject( value ) || typeof value === 'function' ) {
			children = Object.keys( value ).map( key => this.joinKey( key ) );
		}

		else if ( value != null ) {
			// TODO: this will return incorrect keypath if model is mapped
			throw new Error( `Cannot get values of ${this.getKeypath()}.* as ${this.getKeypath()} is not an array, object or function` );
		}

		return children;
	}

	has ( key ) {
		const value = this.get();
		if ( !value ) return false;

		key = unescapeKey( key );
		if ( hasProp.call( value, key ) ) return true;

		// We climb up the constructor chain to find if one of them contains the key
		let constructor = value.constructor;
		while ( constructor !== Function && constructor !== Array && constructor !== Object ) {
			if ( hasProp.call( constructor.prototype, key ) ) return true;
			constructor = constructor.constructor;
		}

		return false;
	}

	joinKey ( key ) {
		if ( key === undefined || key === '' ) return this;

		if ( !this.childByKey.hasOwnProperty( key ) ) {
			const child = new Model( this, key );
			this.children.push( child );
			this.childByKey[ key ] = child;
		}

		return this.childByKey[ key ];
	}

	joinAll ( keys ) {
		let model = this;
		for ( let i = 0; i < keys.length; i += 1 ) {
			model = model.joinKey( keys[i] );
		}

		return model;
	}

	mark () {
		const value = this.retrieve();

		if ( !isEqual( value, this.value ) ) {
			this.value = value;

			this.children.forEach( mark );

			this.deps.forEach( handleChange );
			this.clearUnresolveds();
		}
	}

	merge ( array, comparator ) {
		const oldArray = comparator ? this.value.map( comparator ) : this.value;
		const newArray = comparator ? array.map( comparator ) : array;

		const oldLength = oldArray.length;

		let usedIndices = {};
		let firstUnusedIndex = 0;

		const newIndices = oldArray.map( item => {
			let index;
			let start = firstUnusedIndex;

			do {
				index = newArray.indexOf( item, start );

				if ( index === -1 ) {
					return -1;
				}

				start = index + 1;
			} while ( ( usedIndices[ index ] === true ) && start < oldLength );

			// keep track of the first unused index, so we don't search
			// the whole of newArray for each item in oldArray unnecessarily
			if ( index === firstUnusedIndex ) {
				firstUnusedIndex += 1;
			}
			// allow next instance of next "equal" to be found item
			usedIndices[ index ] = true;
			return index;
		});

		this.parent.value[ this.key ] = array;
		this._merged = true;
		this.shuffle( newIndices );
	}

	register ( dep ) {
		this.deps.push( dep );
	}

	registerTwowayBinding ( binding ) {
		this.bindings.push( binding );
	}

	retrieve () {
		return this.parent.value ? this.parent.value[ this.key ] : undefined;
	}

	set ( value ) {
		if ( this.ticker ) this.ticker.stop();
		this.applyValue( value );
	}

	shuffle ( newIndices ) {
		const indexModels = [];

		newIndices.forEach( ( newIndex, oldIndex ) => {
			if ( !~newIndex ) return;

			const model = this.indexModels[ oldIndex ];

			if ( !model ) return;

			indexModels[ newIndex ] = model;

			if ( newIndex !== oldIndex ) {
				model.rebind( newIndex );
			}
		});

		this.indexModels = indexModels;

		// shuffles need to happen before marks...
		this.deps.forEach( dep => {
			if ( dep.shuffle ) dep.shuffle( newIndices );
		});

		this.updateKeypathDependants();
		this.mark();

		// ...but handleChange must happen after (TODO document why)
		this.deps.forEach( dep => {
			if ( !dep.shuffle ) dep.handleChange();
		});
	}

	teardown () {
		this.children.forEach( teardown );
		if ( this.wrapper ) this.wrapper.teardown();
		if ( this.keypathModels ) {
			for ( let k in this.keypathModels ) {
				this.keypathModels[ k ].teardown();
			}
		}
		this.deps = [];
	}

	unregister ( dependant ) {
		removeFromArray( this.deps, dependant );
	}

	unregisterTwowayBinding ( binding ) {
		removeFromArray( this.bindings, binding );
	}

	updateFromBindings ( cascade ) {
		let i = this.bindings.length;
		while ( i-- ) {
			const value = this.bindings[i].getValue();
			if ( value !== this.value ) this.set( value );
		}

		if ( cascade ) {
			this.children.forEach( updateFromBindings );
		}
	}

	updateKeypathDependants () {
		this.children.forEach( updateKeypathDependants );
		if ( this.keypathModel ) this.keypathModel.handleChange();
	}
}

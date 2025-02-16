import produce from 'immer';
import unset from 'lodash/unset';
import get from 'lodash/get';
import set from 'lodash/set';
import take from 'lodash/take';
import cloneDeep from 'lodash/cloneDeep';
import uniqBy from 'lodash/uniqBy';
import merge from 'lodash/merge';
import castArray from 'lodash/castArray';
import isNil from 'lodash/isNil';

import {
  findLeafByPathAndReplace,
  moveFields,
  recursivelyFindPathsBasedOnCondition,
} from './utils';
import { getMaxTempKey } from '../../utils';

const initialState = {
  componentsDataStructure: {},
  contentTypeDataStructure: {},
  formErrors: {},
  initialData: {},
  modifiedData: null,
  shouldCheckErrors: false,
  modifiedDZName: null,
  publishConfirmation: {
    show: false,
    draftCount: 0,
  },
};

const reducer = (state, action) =>
  // eslint-disable-next-line consistent-return
  produce(state, (draftState) => {
    switch (action.type) {
      case 'ADD_NON_REPEATABLE_COMPONENT_TO_FIELD': {
        const { componentLayoutData, allComponents } = action;

        const relationPaths = recursivelyFindPathsBasedOnCondition(
          allComponents,
          (value) => value.type === 'relation'
        )(componentLayoutData.attributes);

        const defaultDataStructure = {
          ...state.componentsDataStructure[componentLayoutData.uid],
        };

        const repeatableFields = recursivelyFindPathsBasedOnCondition(
          allComponents,
          (value) => value.type === 'component' && value.repeatable
        )(componentLayoutData.attributes);

        const componentDataStructure = relationPaths.reduce((acc, current) => {
          const [componentName] = current.split('.');

          /**
           * Why do we do this? Because if a repeatable component
           * has another repeatable component inside of it we
           * don't need to attach the array at this point because that will be
           * done again deeper in the nest.
           */
          if (!repeatableFields.includes(componentName)) {
            set(acc, current, []);
          }

          return acc;
        }, defaultDataStructure);

        set(draftState, ['modifiedData', ...action.keys], componentDataStructure);

        break;
      }
      case 'ADD_COMPONENT_TO_DYNAMIC_ZONE':
      case 'ADD_REPEATABLE_COMPONENT_TO_FIELD': {
        const { keys, allComponents, componentLayoutData, shouldCheckErrors } = action;

        if (shouldCheckErrors) {
          draftState.shouldCheckErrors = !state.shouldCheckErrors;
        }

        if (action.type === 'ADD_COMPONENT_TO_DYNAMIC_ZONE') {
          draftState.modifiedDZName = keys.join('.');;
        }

        const currentValue = get(state, ['modifiedData', ...keys], []);

        const defaultDataStructure =
          action.type === 'ADD_COMPONENT_TO_DYNAMIC_ZONE'
            ? {
                ...state.componentsDataStructure[componentLayoutData.uid],
                __component: componentLayoutData.uid,
                __temp_key__: getMaxTempKey(currentValue) + 1,
              }
            : {
                ...state.componentsDataStructure[componentLayoutData.uid],
                __temp_key__: getMaxTempKey(currentValue) + 1,
              };

        const relationPaths = recursivelyFindPathsBasedOnCondition(
          allComponents,
          (value) => value.type === 'relation'
        )(componentLayoutData.attributes);

        const repeatableFields = recursivelyFindPathsBasedOnCondition(
          allComponents,
          (value) => value.type === 'component' && value.repeatable
        )(componentLayoutData.attributes);

        const nonRepeatableComponentPaths = recursivelyFindPathsBasedOnCondition(
          allComponents,
          (value) => value.type === 'component' && !value.repeatable
        )(componentLayoutData.attributes);

        const componentDataStructure = relationPaths.reduce((acc, current) => {
          const [componentName] = current.split('.');

          /**
           * Why do we do this? Because if a repeatable component
           * has another repeatable component inside of it we
           * don't need to attach the array at this point because that will be
           * done again deeper in the nest.
           *
           * We also need to handle cases with single components nested within
           * repeatables by checking that the relation path does not match a
           * non-repeatable component path. This accounts for component
           * structures such as:
           * - outer_single_compo
           *    - level_one_repeatable
           *        - level_two_single_component
           *            - level_three_repeatable
           */

          if (
            !repeatableFields.includes(componentName) &&
            !nonRepeatableComponentPaths.includes(componentName)
          ) {
            set(acc, current, []);
          }

          return acc;
        }, defaultDataStructure);

        const newValue = Array.isArray(currentValue)
          ? [...currentValue, componentDataStructure]
          : [componentDataStructure];

        set(draftState, ['modifiedData', ...keys], newValue);

        break;
      }
      case 'LOAD_RELATION': {
        const { initialDataPath, modifiedDataPath, value } = action;

        const initialDataRelations = get(state, initialDataPath);
        const modifiedDataRelations = get(state, modifiedDataPath);

        /**
         * Check if the values we're loading are already in initial
         * data if they are then we don't need to load them at all
         */
        const valuesToLoad = value.filter((relation) => {
          return !initialDataRelations.some((initialDataRelation) => {
            return initialDataRelation.id === relation.id;
          });
        });

        set(draftState, initialDataPath, uniqBy([...valuesToLoad, ...initialDataRelations], 'id'));

        /**
         * We need to set the value also on modifiedData, because initialData
         * and modifiedData need to stay in sync, so that the CM can compare
         * both states, to render the dirty UI state
         */
        set(
          draftState,
          modifiedDataPath,
          uniqBy([...valuesToLoad, ...modifiedDataRelations], 'id')
        );

        break;
      }
      case 'CONNECT_RELATION': {
        const path = ['modifiedData', ...action.keys];
        const { value, toOneRelation } = action;

        /**
         * If the field is a single relation field we don't want to append
         * we just want to replace the value.
         */
        if (toOneRelation) {
          set(draftState, path, [value]);
        } else {
          const modifiedDataRelations = get(state, path);
          const newRelations = [...modifiedDataRelations, value];
          set(draftState, path, newRelations);
        }

        break;
      }
      case 'DISCONNECT_RELATION': {
        const path = ['modifiedData', ...action.keys];
        const { id } = action;
        const modifiedDataRelation = get(state, [...path]);

        const newRelations = modifiedDataRelation.filter((rel) => rel.id !== id);

        set(draftState, path, newRelations);

        break;
      }
      case 'MOVE_COMPONENT_FIELD':
      case 'REORDER_RELATION': {
        const { oldIndex, newIndex, keys } = action;
        const path = ['modifiedData', ...keys];
        const modifiedDataRelations = get(state, [...path]);

        const currentItem = modifiedDataRelations[oldIndex];

        const newRelations = [...modifiedDataRelations];

        newRelations.splice(oldIndex, 1);
        newRelations.splice(newIndex, 0, currentItem);

        set(draftState, path, newRelations);

        break;
      }
      /**
       * This action will be called when you open your entry (first load)
       * but also every time you press publish.
       */
      case 'INIT_FORM': {
        const {
          initialValues,
          relationalFieldPaths = [],
          componentPaths = [],
          repeatableComponentPaths = [],
          dynamicZonePaths = [],
          setModifiedDataOnly,
        } = action;

        /**
         * You can't mutate an actions value.
         * and spreading an object only clones
         * the first level, the deeply nested values
         * are a reference.
         */
        const data = cloneDeep(initialValues);

        /**
         * relationalFieldPaths won't be an array which is what we're expecting
         * Therefore we reset these bits of state to the correct data type
         * which is an array. Hence why we replace those fields.
         *
         */

        const mergeDataWithPreparedRelations = relationalFieldPaths
          .map((path) => path.split('.'))
          .reduce((acc, currentPaths) => {
            const [componentName] = currentPaths;

            const existingComponents = castArray(acc[componentName] || []);
            existingComponents.reduce((result, currentEntry) => {
              if (!isNil(get(currentEntry, [`__temp_key__`]))) {
                return result;
              }

              set(currentEntry, [`__temp_key__`], getMaxTempKey(result) + 1);

              return result;
            }, existingComponents);

            if (state.modifiedData && get(state.modifiedData, componentName)) {
              /**
               * this will be null on initial load, however subsequent calls
               * will have data in them correlating to the names of the relational fields.
               *
               * We also merge the fetched data so that things like `id` for components can be copied over
               * which would be `undefined` in the `browserState`.
               */
              const currentState = cloneDeep(get(state.modifiedData, componentName));
              set(acc, componentName, merge(currentState, get(initialValues, componentName)));
            } else if (
              repeatableComponentPaths.includes(componentName) ||
              dynamicZonePaths.includes(componentName) ||
              componentPaths.includes(componentName)
            ) {
              /**
               * if the componentName is a repeatable field or dynamic zone we collect the list of paths e.g.
               * ["repeatable_single_component_relation","categories"] and then reduce this
               * recursively
               */
              const findleaf = findLeafByPathAndReplace(currentPaths.slice(-1)[0], []);
              currentPaths.reduce(findleaf, acc);
            } else {
              set(acc, currentPaths, []);
            }

            return acc;
          }, data);

        if (!setModifiedDataOnly) {
          draftState.initialData = mergeDataWithPreparedRelations;
        }

        draftState.modifiedData = mergeDataWithPreparedRelations;

        draftState.formErrors = {};

        draftState.modifiedDZName = null;
        draftState.shouldCheckErrors = false;
        break;
      }
      case 'MOVE_COMPONENT_UP':
      case 'MOVE_COMPONENT_DOWN': {
        const { currentIndex, dynamicZoneName, shouldCheckErrors } = action;

        if (shouldCheckErrors) {
          draftState.shouldCheckErrors = !state.shouldCheckErrors;
        }
        const currentValue = get(state.modifiedData, dynamicZoneName);
        const nextIndex = action.type === 'MOVE_COMPONENT_UP' ? currentIndex - 1 : currentIndex + 1;
        const valueToInsert = get(state.modifiedData, dynamicZoneName)[currentIndex];
        const updatedValue = moveFields(currentValue, currentIndex, nextIndex, valueToInsert);
        set(draftState.modifiedData, action.dynamicZoneName, updatedValue);
        break;
      }
      case 'MOVE_FIELD': {
        const currentValue = get(state, ['modifiedData', ...action.keys], []).slice();
        const valueToInsert = get(state, ['modifiedData', ...action.keys, action.dragIndex]);
        const updatedValue = moveFields(
          currentValue,
          action.dragIndex,
          action.overIndex,
          valueToInsert
        );

        set(draftState, ['modifiedData', ...action.keys], updatedValue);

        break;
      }
      case 'ON_CHANGE': {
        const [nonRepeatableComponentKey] = action.keys;

        // This is used to set the initialData for inputs
        // that needs an asynchronous initial value like the UID field
        // This is just a temporary patch.
        // TODO : Refactor the default form creation (workflow) to accept async default values.
        if (action.shouldSetInitialValue) {
          set(draftState, ['initialData', ...action.keys], action.value);
        }

        // FIXME: not sure this is needed...
        if (
          action.keys.length === 2 &&
          get(state, ['modifiedData', nonRepeatableComponentKey]) === null
        ) {
          set(draftState, ['modifiedData', nonRepeatableComponentKey], {
            [action.keys[1]]: action.value,
          });

          break;
        }

        set(draftState, ['modifiedData', ...action.keys], action.value);

        break;
      }
      case 'REMOVE_COMPONENT_FROM_DYNAMIC_ZONE': {
        if (action.shouldCheckErrors) {
          draftState.shouldCheckErrors = !state.shouldCheckErrors;
        }
        get(draftState.modifiedData, action.dynamicZoneName).splice(action.index, 1);
        // draftState.modifiedData[action.dynamicZoneName].splice(action.index, 1);

        break;
      }
      case 'REMOVE_COMPONENT_FROM_FIELD': {
        const componentPathToRemove = ['modifiedData', ...action.keys];

        set(draftState, componentPathToRemove, null);

        break;
      }
      case 'REMOVE_PASSWORD_FIELD': {
        unset(draftState, ['modifiedData', ...action.keys]);

        break;
      }
      case 'REMOVE_REPEATABLE_FIELD': {
        const keysLength = action.keys.length - 1;
        const pathToComponentData = ['modifiedData', ...take(action.keys, keysLength)];
        const hasErrors = Object.keys(state.formErrors).length > 0;

        if (hasErrors) {
          draftState.shouldCheckErrors = !state.shouldCheckErrors;
        }

        const currentValue = get(state, pathToComponentData).slice();
        currentValue.splice(parseInt(action.keys[keysLength], 10), 1);

        set(draftState, pathToComponentData, currentValue);

        break;
      }
      case 'SET_DEFAULT_DATA_STRUCTURES': {
        draftState.componentsDataStructure = action.componentsDataStructure;
        draftState.contentTypeDataStructure = action.contentTypeDataStructure;

        break;
      }
      case 'SET_FORM_ERRORS': {
        draftState.modifiedDZName = null;
        draftState.formErrors = action.errors;
        break;
      }
      case 'TRIGGER_FORM_VALIDATION': {
        const hasErrors = Object.keys(state.formErrors).length > 0;

        if (hasErrors) {
          draftState.shouldCheckErrors = !state.shouldCheckErrors;
        }

        break;
      }
      case 'SET_PUBLISH_CONFIRMATION': {
        draftState.publishConfirmation = { ...action.publishConfirmation };
        break;
      }
      case 'RESET_PUBLISH_CONFIRMATION': {
        draftState.publishConfirmation = { ...state.publishConfirmation, show: false };
        break;
      }
      default:
        return draftState;
    }
  });

export default reducer;
export { initialState };

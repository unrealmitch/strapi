import { useMemo } from 'react';
import { get } from 'lodash';
import { useCMEditViewDataManager } from '@strapi/helper-plugin';

function useSelect(name) {
  const {
    addComponentToDynamicZone,
    createActionAllowedFields,
    isCreatingEntry,
    formErrors,
    modifiedData,
    moveComponentField,
    removeComponentFromDynamicZone,
    readActionAllowedFields,
    updateActionAllowedFields,
  } = useCMEditViewDataManager();

  const dynamicDisplayedComponents = useMemo(
    () =>
      get(modifiedData, name, []).map((data) => {
        return {
          componentUid: data.__component,
          id: data.id ?? data.__temp_key__,
        };
      }),
    [modifiedData, name]
  );

  const contains = (items, name) => {
    const parts = name.split('.');
    const canonicalName = parts
      .filter(part => {
        return Number.isNaN(part) || Number.isNaN(parseFloat(part));
      })
      .join('.');

    return items.includes(canonicalName);
  };

  const isFieldAllowed = useMemo(() => {
    const allowedFields = isCreatingEntry ? createActionAllowedFields : updateActionAllowedFields;

    return contains(allowedFields, name);
  }, [name, isCreatingEntry, createActionAllowedFields, updateActionAllowedFields]);

  const isFieldReadable = useMemo(() => {
    const allowedFields = isCreatingEntry ? [] : readActionAllowedFields;

    return contains(allowedFields, name);
  }, [name, isCreatingEntry, readActionAllowedFields]);

  return {
    addComponentToDynamicZone,
    formErrors,
    isCreatingEntry,
    isFieldAllowed,
    isFieldReadable,
    moveComponentField,
    removeComponentFromDynamicZone,
    dynamicDisplayedComponents,
  };
}

export default useSelect;

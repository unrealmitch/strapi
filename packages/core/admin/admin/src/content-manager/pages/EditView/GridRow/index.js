import React from 'react';
import PropTypes from 'prop-types';
import { Grid, GridItem } from '@strapi/design-system';
import Inputs from '../../../components/Inputs';
import FieldComponent from '../../../components/FieldComponent';
import DynamicZone from '../../../components/DynamicZone';

const GridRow = ({ columns, customFieldInputs }) => {
  return (
    <Grid gap={4}>
      {columns.map(({ fieldSchema, labelAction, metadatas, name, size, queryInfos }) => {
        const isComponent = fieldSchema.type === 'component';
        const isDynamicZone = fieldSchema.type === 'dynamiczone';

        if (isComponent) {
          const { component, max, min, repeatable = false, required = false } = fieldSchema;
          return (
            <GridItem col={size} s={12} xs={12} key={component}>
              <FieldComponent
                componentUid={component}
                labelAction={labelAction}
                isRepeatable={repeatable}
                intlLabel={{
                  id: metadatas.label,
                  defaultMessage: metadatas.label,
                }}
                max={max}
                min={min}
                name={name}
                required={required}
              />
            </GridItem>
          );
        }

        if (isDynamicZone) {
          return (
            <GridItem col={size} s={12} xs={12} key={fieldSchema.name}>
              <DynamicZone
                name={name}
                fieldSchema={fieldSchema}
                labelAction={labelAction}
                metadatas={metadatas}
              />
            </GridItem>
          );
        }

        return (
          <GridItem col={size} key={name} s={12} xs={12}>
            <Inputs
              size={size}
              fieldSchema={fieldSchema}
              keys={name}
              labelAction={labelAction}
              metadatas={metadatas}
              queryInfos={queryInfos}
              customFieldInputs={customFieldInputs}
            />
          </GridItem>
        );
      })}
    </Grid>
  );
};

GridRow.defaultProps = {
  customFieldInputs: {},
};

GridRow.propTypes = {
  columns: PropTypes.array.isRequired,
  customFieldInputs: PropTypes.object,
};

export default GridRow;

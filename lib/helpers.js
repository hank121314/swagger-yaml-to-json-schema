'use strict';

const _ = require('lodash');

/**
 * Find all nested sub-objects by the key
 * Credit: Bergi (https://stackoverflow.com/users/1048572/bergi)
 * Borrowed from: https://stackoverflow.com/questions/15642494/find-property-by-name-in-a-deep-object
 *
 * @param {Object} obj - The parent object to search
 * @param {String} key - The key to search for
 *
 * @returns {Array} An array of sub-objects that match the key
 */
function findInNested(obj, key) {
  if (_.has(obj, key)) return [obj]; // array of containing objects

  return _.flatten(
    _.map(obj, (v) => (typeof v === 'object' ? findInNested(v, key) : [])),
    true
  );
}

/**
 * Transform combine schema object to array
 * @param {Object} schema - schema which might contain property `oneOf`, `allOf`, `anyOf` 
 */
function resolveCombineSchema(schema) {
  let combine_schema;
  if (schema.oneOf) {
    combine_schema = schema.oneOf;
  } else if (schema.allOf) {
    combine_schema = schema.allOf;
  } else if (schema.anyOf) {
    combine_schema = schema.anyOf;
  }
  return combine_schema;
}

/**
 * Generate "properties" from Swagger paths
 *
 * @param {Object} swagger - Swagger/OpenAPI specification
 * @param {Object} schemaProps - Schema "properties" object
 */
function addSchemaProps(swagger, schemaProps) {
  try {
    // Find all "schema" sub-objects in Swagger JSON
    const result = get_path('schema', swagger);

    for (const paths of result) {
      let container = _.get(swagger, _.dropRight(paths.split('.')).join('.'));
      let propPath = '';
      let propName = '';

      if (container.name) {
        propName = container.name;
      }

      if (container.schema.type) {
        if (container.schema.type === 'array') {
          propPath = container.schema.items.$ref;
          // if propPath is nil means that it's not $ref, no naming needed.
          if (!propPath) {
            continue;
          }

          if (!propName) {
            propName = 'arrayOf'.concat(propPath.slice(propPath.lastIndexOf('/') + 1));
          }
        } else {
          // For scalar types if we can't find the property name,
          // use keyPath to name it.
          if (!propName) {
            let keyPath = _.drop(paths.split('.'));
            propName = `${keyPath[0].substring(1) + '_' + keyPath[2]}`;
          }
        }
      } else if (container.schema.oneOf || container.schema.allOf || container.schema.anyOf) {
        const combine_schema = resolveCombineSchema(container.schema);
        combine_schema.forEach((ref) => {
          propPath = ref.$ref;
          propName = propPath.slice(propPath.lastIndexOf('/') + 1);

          // lowercase the first letter
          propName = propName.charAt(0).toLocaleLowerCase().concat(propName.slice(1));

          schemaProps[propName] = container.schema;
          schemaProps[propName].description = container.description;
        });
        continue;
      } else {
        propPath = container.schema.$ref;
        propName = propPath.slice(propPath.lastIndexOf('/') + 1);

        // lowercase the first letter
        propName = propName.charAt(0).toLocaleLowerCase().concat(propName.slice(1));
      }

      schemaProps[propName] = container.schema;
      schemaProps[propName].description = container.description;
    }
  } catch (err) {
    throw new Error(
      `Could not parse Swagger paths, make sure that each schema that is not a $ref has a type.\n  ${err}`
    );
  }
}

/**
 * Convert Swagger "nullable" to "type": "null" in a JSON schema
 *
 * @param {Object} schemaObj - An Object representing the JSON schema
 */
function convertNullables(schemaObj) {
  const withNullables = findInNested(schemaObj, 'nullable');

  for (let item of withNullables) {
    delete item.nullable;
    item.type = [item.type, 'null'];
  }
}

/**
 * Find all path which can access to `keyWord`
 *
 * @param {String} keyWord - the keyWord you want to sear
 */
function get_path(keyWord, obj, previous_path = null) {
  let path;
  return Object.keys(obj).reduce((acc, key) => {
    if (key === keyWord || obj[key] === keyWord) {
      return acc.concat(`${previous_path}.${key}`);
    }
    if (typeof obj[key] !== 'object' || _.isNil(obj[key])) {
      return acc;
    }
    if (previous_path === null) {
      path = key;
    } else {
      path = `${previous_path}.${key}`;
    }
    return acc.concat(get_path(keyWord, obj[key], path));
  }, []);
}

/**
 * Pop an array until its pop() value equals to keyWord
 * 
 * @param {Array} array Array that you want to pop
 * @param {String} keyWord A word that you want pop to stop.
 */
function pop_until(array, keyWord) {
  const tmp = [...array];
  while (keyWord !== tmp.pop() && tmp.length > 0);
  return tmp;
}

module.exports = {
  addSchemaProps,
  convertNullables,
  pop_until,
  get_path,
};

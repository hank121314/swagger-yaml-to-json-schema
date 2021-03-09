'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const refParser = require('json-schema-ref-parser');
const util = require('util');
const got = require('got');
const validUrl = require('valid-url');
const _ = require('lodash');

const helpers = require('./helpers');

const DESCRIPTION = 'Generate JSON schema from Swagger, OpenAPI, or AsyncAPI YAML document';

// Promisify ref parser
refParser.parseRefs = util.promisify(refParser.dereference);

// Store Swagger/OpenAPI JSON representation
let swagger = {};

/**
 * Input file reader
 *
 * @param {String} yamlFile - Swagger/OpenAPI YAML file name
 *
 * @returns {Object} JSON representation of the Swagger/OpenAPI specification
 */
function ingestYAML(yamlFile) {
  const swaggerYAML = fs.readFileSync(yamlFile).toString();

  swagger = toJSON(swaggerYAML);

  return swagger;
}

/**
 * load $ref file.
 *
 * @param {String} yamlFile - Swagger/OpenAPI YAML file name
 * @param {String} root - root of the fs
 * @returns {Object} JSON representation of the Swagger/OpenAPI specification
 */
async function loadReferenceFile(yamlFile, root) {
  if (validUrl.isUri(yamlFile)) {
    const swaggerYAML = await got(yamlFile).buffer().toString();

    swagger = yaml.safeLoad(swaggerYAML);

    return swagger;
  }
  if (yamlFile) {
    let yamlPath = yamlFile;
    if (root) {
      yamlPath = path.join(root, yamlFile);
    }
    const swaggerYAML = fs.readFileSync(yamlPath).toString();
    swagger = yaml.safeLoad(swaggerYAML);

    return swagger;
  }
}

/**
 * YAML to JSON converter
 *
 * @param {String} fromYAML - Swagger/OpenAPI YAML specification
 *
 * @returns {Object} JSON representation of the input
 */
function toJSON(fromYAML) {
  // Convert to JSON
  const swaggerJSON = yaml.safeLoad(fromYAML);
  // Determine the spec version (supported Swagger 2.* or OpenAPI 3.* or AsyncAPI 2.*)
  const swaggerVersion = swaggerJSON.swagger;
  const openAPIVersion = swaggerJSON.openapi;
  const asyncAPIVersion = swaggerJSON.asyncapi;

  if (swaggerVersion) {
    if (swaggerVersion.toString().startsWith('2')) {
      return swaggerJSON;
    } else {
      return null;
    }
  } else if (openAPIVersion) {
    if (openAPIVersion.toString().startsWith('3')) {
      return swaggerJSON;
    } else {
      return null;
    }
  } else if (asyncAPIVersion) {
    if (asyncAPIVersion.toString().startsWith('2')) {
      return swaggerJSON;
    } else {
      return null;
    }
  } else {
    return null;
  }
}

/**
 * Resolve swagger $ref
 *
 * @param {Object} swagger - JSON representation of the Swagger/OpenAPI specification
 * @param {Object} configuration - configuration object
 *
 * @returns {Object} Swagger schema with resolved $ref
 */
async function resolve$ref(swagger, root, configuration) {
  if (configuration.resolveRefs) {
    let keyPaths = helpers.get_path('$ref', swagger);
    let components = [];
    // if keyPath from swagger is startsWith `#`, we should ignore it since it's already in swagger(root).
    keyPaths = keyPaths.filter((keyPath) => !_.get(swagger, keyPath).startsWith('#'));
    const reference_files = await Promise.all(
      keyPaths.map((keyPath) => loadReferenceFile(_.get(swagger, keyPath), root))
    );
    reference_files.forEach(($ref, index) => {
      const keyPath = keyPaths[index];
      const ref_name = keyPath.split('.').slice(-2, -1)[0];
      const refPaths = helpers.get_path('$ref', $ref);
      refPaths.forEach((refPath) => {
        const definitions = _.get($ref, refPath).split('/');
        const type = definitions.pop();
        // if keyPath from $ref is not startsWith `#` means $ref might also reference others yaml.
        // But we read all yaml at main, so we need to resolve it $ref to main.
        if (!_.get($ref, refPath).startsWith('#')) {
          const prefix_length = helpers.pop_until(definitions, 'components').length;
          _.set(
            $ref,
            refPath,
            '#/' +
              definitions
                .slice(prefix_length)
                .concat('components_' + type)
                .join('/')
          );
          return;
        }
        _.set(
          $ref,
          refPath,
          definitions.concat((ref_name.startsWith('/') ? ref_name.substring(1) : ref_name) + '_' + type).join('/')
        );
      });
      _.set(swagger, _.dropRight(keyPath.split('.'), 1), _.omit($ref, ['components']));
      if ($ref.components) {
        components.push({ [ref_name]: _.pick($ref, ['components']).components.schemas });
      }
    });
    components = components.reduce(
      (acc, comp) => ({
        ...Object.keys(comp).reduce(
          (memo, curr) => ({
            ..._.mapKeys(comp[curr], (_value, key) => (curr.startsWith('/') ? curr.substring(1) : curr) + '_' + key),
            ...memo,
          }),
          {}
        ),
        ...acc,
      }),
      {}
    );
    if (!_.isEmpty(components)) {
      _.set(swagger, 'components.schemas', components);
    }
  }
  return swagger;
}

/**
 * Schema generator
 *
 * @param {Object} swagger - JSON representation of the Swagger/OpenAPI specification
 * @param {Object} configuration - configuration object
 *
 * @returns {Promise<Object>} Promise that resolves to the JSON schema object
 *
 * @throws Error on dereferencing failure
 */
async function makeSchema(swagger, root, configuration) {
  await resolve$ref(swagger, root, configuration);
  // This initialization is to insure that these two keywords
  // appear first in the resulting file -- it is only for aesthetic purposes
  let schema = {
    $schema: null,
    $id: null,
    title: swagger.info.title,
    version: swagger.info.version,
    description: swagger.info.description || 'No description provided',
  };

  // Extract schema
  let schemaPart = null;
  let schemaProperties = {};

  // At this point we can be sure that it's either Swagger 2 or OpenAPI 3
  // as it already has been validated
  if (swagger.swagger) {
    // Swagger 2
    schemaPart = swagger.definitions;
  } else if (swagger.asyncapi) {
    // AsyncAPI 2
    schemaPart = swagger.components.schemas;
    schemaProperties = extractSchemaPropertiesFromAsyncAPI(swagger.components.messages);
  } else {
    // OpenAPI 3
    schemaPart = swagger.components.schemas;
  }

  // Create JSON schema
  schema.$schema = configuration.schema;

  // If no id is given, remove it from the schema -- empty strings are not allowed
  if (configuration.id) {
    schema.$id = configuration.id;
  } else {
    delete schema.$id;
  }

  schema.additionalProperties = configuration.additionalProperties;

  schema.properties = {
    schemaVersion: {
      type: 'string',
      description: 'The version of this schema that will be used to validate JSON data',
    },
    ...schemaProperties,
  };

  schema.required = ['schemaVersion'];

  // Find "schema"s in the "paths" -- they will go to the properties key
  helpers.addSchemaProps(swagger, schema.properties);

  // Add all entity defintions
  schema.definitions = schemaPart;

  // Process nullable types
  helpers.convertNullables(schema.definitions);

  // If this is an OpenAPI 3 spec, we need to change all $refs from
  // #/components/schemas to #/definitions
  // this we can do by simply doing text search and replace
  if (swagger.openapi || swagger.asyncapi) {
    let oldSchemaText = JSON.stringify(schema);
    let newSchemaText = oldSchemaText.replaceAll(new RegExp('#/components/schemas', 'g'), '#/definitions');
    schema = JSON.parse(newSchemaText);
  }

  // Resolve $refs if specified
  if (configuration.resolveRefs) {
    try {
      schema = await refParser.parseRefs(schema);
    } catch (err) {
      throw new Error(`Could not resolve $refs\n  ${err}`);
    }
  }

  // After resolve $refs trying to re-map array.
  const arrayPath = helpers.get_path('array', schema);
  arrayPath.forEach((keyPath) => {
    const itemsPath = keyPath.split('.').slice(0, -1).join('.') + '.items';
    const value = _.get(schema, itemsPath);
    if (typeof value === 'string' && !_.isNil(value)) {
      _.set(schema, itemsPath, { type: value });
    }
  });
  // After resolve $refs trying to re-map required boolean to required collections.
  const requiredPath = helpers.get_path('required', schema);
  // should_pass will contain the object which already have required collections.
  const should_pass = requiredPath.map((keyPath) => {
    if (Array.isArray(_.get(schema, keyPath))) {
      return keyPath.split('.').slice(0, -1).join('.');
    }
  });
  const requiredParentPath = _.uniq(
    requiredPath.map((keyPath) => helpers.pop_until(keyPath.split('.'), 'properties').join('.'))
  ).filter((keyPath) => !_.isEmpty(keyPath));
  requiredParentPath.forEach((keyPath) => {
    const schemas_properties = _.get(schema, keyPath);
    Object.keys(schemas_properties.properties).forEach((key_path_required_path) => {
      if (should_pass.includes(key_path_required_path)) {
        return;
      }
      const required_path = keyPath + `.properties.${key_path_required_path}`;
      const required_key = key_path_required_path;
      const properties_path = helpers.pop_until(required_path.split('.'), 'properties').join('.');
      let required_collections = _.get(schema, properties_path.concat('.required')) || [];
      if (!Array.isArray(required_collections)) {
        required_collections = [];
      }
      if (!required_collections.includes(required_key)) {
        const properties = _.get(schema, required_path);
        _.set(schema, required_path, _.omit(properties, ['required']));
        const value = _.get(schema, properties_path);
        _.set(schema, properties_path, {
          ...value,
          required: required_collections.concat(required_key),
        });
      }
    });
  });

  return schema;
}

function extractSchemaPropertiesFromAsyncAPI(messages) {
  return Array.from(Object.entries(messages)).reduce((r, [key, value]) => {
    if (typeof value.payload === 'object') {
      r[key] = {
        ...value,
        ...value.payload,
      };
      delete r[key].payload;
    }
    return r;
  }, {});
}

module.exports = {
  swagger: () => swagger,
  ingestYAML,
  toJSON,
  makeSchema,
  DESCRIPTION,
};

/** @module index */
'use strict';


// Dependencies
var fs = require('fs');
var glob = require('glob');
var path = require('path');
var doctrine = require('doctrine');
var jsYaml = require('js-yaml');
var parser = require('swagger-parser');

/**
 * Parses the provided API file for JSDoc comments.
 * @function
 * @param {string} file - File to be parsed
 * @returns {{jsdoc: array, yaml: array}} JSDoc comments and Yaml files
 * @requires doctrine
 */
function parseApiFile(file) {
  var jsDocRegex = /\/\*\*([\s\S]*?)\*\//gm;
  var fileContent = fs.readFileSync(file, { encoding: 'utf8' });
  var ext = path.extname(file);
  var yaml = [];
  var jsDocComments = [];

  if (ext === '.yaml' || ext === '.yml') {
    yaml.push(jsYaml.safeLoad(fileContent));
  } else {
    var regexResults = fileContent.match(jsDocRegex);
    if (regexResults) {
      for (var i = 0; i < regexResults.length; i = i + 1) {
        var jsDocComment = doctrine.parse(regexResults[i], { unwrap: true });
        jsDocComments.push(jsDocComment);
      }
    }
  }

  return {
    yaml: yaml,
    jsdoc: jsDocComments,
  };
}


/**
 * Filters JSDoc comments for those tagged with '@swagger'
 * @function
 * @param {array} jsDocComments - JSDoc comments
 * @returns {array} JSDoc comments tagged with '@swagger'
 * @requires js-yaml
 */
function filterJsDocComments(jsDocComments) {
  var swaggerJsDocComments = [];

  for (var i = 0; i < jsDocComments.length; i = i + 1) {
    var jsDocComment = jsDocComments[i];
    for (var j = 0; j < jsDocComment.tags.length; j = j + 1) {
      var tag = jsDocComment.tags[j];
      if (tag.title === 'swagger') {
        swaggerJsDocComments.push(jsYaml.safeLoad(tag.description));
      }
    }
  }

  return swaggerJsDocComments;
}

/**
 * Merges two objects
 * @function
 * @param {object} obj1 - Object 1
 * @param {object} obj2 - Object 2
 * @returns {object} Merged Object
 */
function objectMerge(obj1, obj2) {
  var obj3 = {};
  for (var attr in obj1) {
    if (obj1.hasOwnProperty(attr)) {
      obj3[attr] = obj1[attr];
    }
  }
  for (var name in obj2) {
    if (obj2.hasOwnProperty(name)) {
      obj3[name] = obj2[name];
    }
  }
  return obj3;
}

/**
 * Adds the data in to the swagger object.
 * @function
 * @param {object} swaggerObject - Swagger object which will be written to
 * @param {object[]} data - objects of parsed swagger data from yaml or jsDoc
 *                          comments
 */
function addDataToSwaggerObject(swaggerObject, data) {
  for (var i = 0; i < data.length; i = i + 1) {
    var pathObject = data[i];
    var propertyNames = Object.getOwnPropertyNames(pathObject);
    for (var j = 0; j < propertyNames.length; j = j + 1) {
      var propertyName = propertyNames[j];
      var keyName = propertyName + 's';
      switch (propertyName) {
        case 'securityDefinition':
        case 'response':
        case 'parameter':
        case 'definition': {
          var definitionNames = Object
            .getOwnPropertyNames(pathObject[propertyName]);
          for (var k = 0; k < definitionNames.length; k = k + 1) {
            var definitionName = definitionNames[k];
            swaggerObject[keyName][definitionName] =
              pathObject[propertyName][definitionName];
          }
          break;
        }
        case 'tag': {
          swaggerObject[keyName].push(pathObject[propertyName]);
          break;
        }
        default: {
          swaggerObject.paths[propertyName] = objectMerge(
            swaggerObject.paths[propertyName], pathObject[propertyName]
          );
        }
      }
    }
  }
}

/**
 * Converts an array of globs to full paths
 * @function
 * @param {array} globs - Array of globs and/or normal paths
 * @return {array} Array of fully-qualified paths
 * @requires glob
 */
function convertGlobPaths(globs) {
  return globs.reduce(function (acc, globString) {
    var globFiles = glob.sync(globString);
    return acc.concat(globFiles);
  }, []);
}

/**
 * Generates the swagger spec
 * @function
 * @param {object} options - Configuration options
 * @returns {array} Swagger spec
 * @requires swagger-parser
 */
function getSwaggerSpec(options) {
  /* istanbul ignore if */
  if (!options) {
    throw new Error('\'options\' is required.');
  } else /* istanbul ignore if */ if (!options.swaggerDefinition) {
    throw new Error('\'swaggerDefinition\' is required.');
  } else /* istanbul ignore if */ if (!options.apis) {
    throw new Error('\'apis\' is required.');
  }

  // Build basic swagger json
  var swaggerObject = [];
  swaggerObject = options.swaggerDefinition;
  swaggerObject.swagger = '2.0';
  swaggerObject.paths = {};
  swaggerObject.definitions = {};
  swaggerObject.responses = {};
  swaggerObject.parameters = {};
  swaggerObject.securityDefinitions = {};
  swaggerObject.tags = [];

  var apiPaths = convertGlobPaths(options.apis);

  // Parse the documentation in the APIs array.
  for (var i = 0; i < apiPaths.length; i = i + 1) {
    var files = parseApiFile(apiPaths[i]);
    var swaggerJsDocComments = filterJsDocComments(files.jsdoc);
    addDataToSwaggerObject(swaggerObject, files.yaml);
    addDataToSwaggerObject(swaggerObject, swaggerJsDocComments);
  }

  parser.parse(swaggerObject, function (err, api) {
    if (!err) {
      swaggerObject = api;
    }
  });
  return swaggerObject;
};

function getMergedSwaggerSpec(extendedOptions) {
  const specs = extendedOptions.apis.map(conf => {
    const options = {
      swaggerDefinition: Object.assign({}, extendedOptions.swaggerDefinition),
      // TODO: this path resolve relies on a relative path, might be too fragile
      apis: conf.apis.map(a => path.resolve(extendedOptions.dirName, a)),
    }

    let spec = getSwaggerSpec(options)
    addPathPrefix(conf.prefix, spec)

    return spec
  })

  const target = specs.pop()
  mergeSpecs(target, specs)
  return target

}

function addExternalSpec(targetSpec, external, pathPrefix) {
  let externalSpec = external.getSwaggerSpec()
  addPathPrefix(pathPrefix, externalSpec)

  mergeSpecs(targetSpec, [externalSpec])
}

function addPathPrefix(pathPrefix, spec) {
  Object.keys(spec.paths).forEach(key => {
    renameProperty(spec.paths, key, pathPrefix.concat(key))
  })
}

function renameProperty(obj, oldName, newName) {
  // Do nothing if the names are the same
  if (oldName === newName) {
    return
  }
  // Check for the old property name to avoid a ReferenceError in strict mode.
  if (obj.hasOwnProperty(oldName)) {
    obj[newName] = obj[oldName]
    delete obj[oldName]
  }
}

// TODO: accept param list instead of array
function mergeSpecs(target, sources) {
  sources.forEach(spec => {
    Object.keys(target).forEach(key => {
      const keyType = typeof target[key]
      if (keyType === 'object') {
        target[key] = Object.assign(spec[key], target[key])
      } else if (keyType === 'array') {
        target[key].push(...spec[key])
      } else {
        // TODO: remove console.log
        console.log(`dont know how to merge ${key} with type ${keyType}`)
      }
    })
  })
}

function CORSFilter(req, res, next) {
  // allows some basic headers
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.header('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS, PATCH')

  // allows access from any origin
  res.header('Access-Control-Allow-Origin', '*')

  // adds the required credentials header
  res.header('Access-Control-Allow-Credentials', 'true')

  next()
}

module.exports = {
  getSwaggerSpec,
  getMergedSwaggerSpec,
  addExternalSpec,
  CORSFilter
}

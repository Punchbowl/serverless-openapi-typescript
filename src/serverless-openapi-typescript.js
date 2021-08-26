'use strict';
const { upperFirst, mergeWith, set, isArray, get, isEmpty } = require('lodash');
const tsj = require('ts-json-schema-generator');
const yaml = require('js-yaml');
const fs = require('fs');

class ServerlessOpenapiTypeScript {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.assertPluginOrder();

    this.initOptions(options);
    this.functionsMissingDocumentation = [];

    if (!this.serverless.service.custom.documentation) {
      this.log(
        `Disabling OpenAPI generation for ${this.serverless.service.service} - no 'custom.documentation' attribute found`
      );
      this.disable = true;
      delete this.serverless.pluginManager.hooks['openapi:generate:serverless'];
    }

    if (!this.disable) {
      this.hooks = {
        'before:openapi:generate:serverless': this.populateServerlessWithModels.bind(this),
        'after:openapi:generate:serverless': this.postProcessOpenApi.bind(this)
      };
    }
  }

  initOptions(options) {
    this.options = options || {};
    this.typescriptApiModelPath = this.options.typescriptApiPath || 'api.d.ts';
    this.tsconfigPath = this.options.tsconfigPath || 'tsconfig.json';
  }

  assertPluginOrder() {
    if (!this.serverless.pluginManager.hooks['openapi:generate:serverless']) {
      throw new Error(
        'Please configure your serverless.plugins list so serverless-openapi-documentation-models will be listed AFTER @conqa/serverless-openapi-documentation'
      );
    }
  }

  get functions() {
    return this.serverless.service.functions || {};
  }

  log(msg) {
    this.serverless.cli.log(`[serverless-openapi-documentation-models] ${msg}`);
  }

  async populateServerlessWithModels() {
    this.log('Scanning functions for documentation attribute');
    Object.keys(this.functions).forEach(functionName => {
      const events = get(this.functions, `${functionName}.events`, []);
      events.forEach(event => {
        const httpEvent = event.http;
        if (httpEvent) {
          if (httpEvent.documentation) {
            this.log(`Generating docs for ${functionName}`);

            this.setModels(httpEvent, functionName);

            const paths = get(httpEvent, 'request.parameters.paths', []);
            const querystrings = get(httpEvent, 'request.parameters.querystrings', {});
            [
              { params: paths, documentationKey: 'pathParams' },
              { params: querystrings, documentationKey: 'queryParams' }
            ].forEach(({ params, documentationKey }) => {
              this.setDefaultParamsDocumentation(params, httpEvent, documentationKey);
            });
          } else if (httpEvent.documentation !== null && !httpEvent.private) {
            this.functionsMissingDocumentation.push(functionName);
          }
        }
      });
    });

    this.assertAllFunctionsDocumented();
  }

  assertAllFunctionsDocumented() {
    if (!isEmpty(this.functionsMissingDocumentation)) {
      throw new Error(
        `Some functions have http events which are not documented:
         ${this.functionsMissingDocumentation}
         
        Please add a documentation attribute. 
        If you wish to keep the function undocumented, please explicitly set 
        documentation: ~
         
        `
      );
    }
  }

  setDefaultParamsDocumentation(params, httpEvent, documentationKey) {
    Object.entries(params).forEach(([name, required]) => {
      httpEvent.documentation[documentationKey] = httpEvent.documentation[documentationKey] || [];

      const documentedParams = httpEvent.documentation[documentationKey];
      const existingDocumentedParam = documentedParams.find(documentedParam => documentedParam.name === name);

      if (existingDocumentedParam && typeof existingDocumentedParam.schema === 'string') {
        existingDocumentedParam.schema = this.generateSchema(existingDocumentedParam.schema);
      }

      const paramDocumentationFromSls = {
        name,
        required,
        schema: { type: 'string' }
      };

      if (!existingDocumentedParam) {
        documentedParams.push(paramDocumentationFromSls);
      } else {
        Object.assign(paramDocumentationFromSls, existingDocumentedParam);
        Object.assign(existingDocumentedParam, paramDocumentationFromSls);
      }
    });
  }

  setModels(httpEvent, functionName) {
    const definitionPrefix = `${this.serverless.service.custom.documentation.apiNamespace}.${upperFirst(functionName)}`;
    const method = httpEvent.method.toLowerCase();
    switch (method) {
      case 'delete':
        set(httpEvent, 'documentation.methodResponses', [{ statusCode: 204, responseModels: {} }]);
        break;
      case 'patch':
      case 'put':
      case 'post':
        const requestModelName = `${definitionPrefix}.Request.Body`;
        this.setModel(`${definitionPrefix}.Request.Body`);
        set(httpEvent, 'documentation.requestModels', { 'application/json': requestModelName });
        set(httpEvent, 'documentation.requestBody', { description: '' });
      // no-break;
      case 'get':
        const responseModelName = `${definitionPrefix}.Response`;
        this.setModel(`${definitionPrefix}.Response`);
        set(httpEvent, 'documentation.methodResponses', [
          {
            statusCode: 200,
            responseBody: { description: '' },
            responseModels: { 'application/json': responseModelName }
          }
        ]);
    }
  }

  postProcessOpenApi() {
    const outputFile = this.serverless.processedInput.options.output;
    const openApi = yaml.load(outputFile);
    this.patchOpenApiVersion(openApi);
    this.tagMethods(openApi);
    fs.writeFileSync(outputFile, yaml.dump(openApi));
  }

  patchOpenApiVersion(openApi) {
    this.log(`Setting openapi version to 3.1.0`);
    openApi.openapi = '3.1.0';
    return openApi;
  }

  tagMethods(openApi) {
    const tagName = openApi.info.title;
    openApi.tags = [
      {
        name: tagName,
        description: openApi.info.description
      }
    ];
    Object.values(openApi.paths).forEach(path => {
      Object.values(path).forEach(method => {
        method.tags = [tagName];
      });
    });
  }

  setModel(modelName) {
    mergeWith(
      this.serverless.service.custom,
      {
        documentation: {
          models: [{ name: modelName, contentType: 'application/json', schema: this.generateSchema(modelName) }]
        }
      },
      (objValue, srcValue) => {
        if (isArray(objValue)) {
          return objValue.concat(srcValue);
        }
      }
    );
  }

  generateSchema(modelName) {
    this.log(`Generating schema for ${modelName}`);

    this.schemaGenerator =
      this.schemaGenerator ||
      tsj.createGenerator({
        path: this.typescriptApiModelPath,
        tsconfig: this.tsconfigPath,
        type: `*`,
        expose: 'export',
        skipTypeCheck: true,
        topRef: false
      });

    return this.schemaGenerator.createSchema(modelName);
  }
}

module.exports = ServerlessOpenapiTypeScript;
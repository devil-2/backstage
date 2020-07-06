/*
 * Copyright 2020 Spotify AB
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Logger } from 'winston';
import Router from 'express-promise-router';
import express from 'express';
import {
  PreparerBuilder,
  TemplaterBase,
  JobProcessor,
  RequiredTemplateValues,
  StageContext,
  GithubPublisher,
} from '../scaffolder';
import { TemplateEntityV1alpha1 } from '@backstage/catalog-model';
import Docker from 'dockerode';
import {} from '@backstage/backend-common';
import { Octokit } from '@octokit/rest';
import { JsonValue } from '@backstage/config';

export interface RouterOptions {
  preparers: PreparerBuilder;
  templater: TemplaterBase;
  logger: Logger;
  dockerClient: Docker;
}

export async function createRouter(
  options: RouterOptions,
): Promise<express.Router> {
  const router = Router();

  const githubClient = new Octokit({ auth: process.env.GITHUB_ACCESS_TOKEN });
  const { preparers, templater, logger: parentLogger, dockerClient } = options;
  const githubPulisher = new GithubPublisher({ client: githubClient });
  const logger = parentLogger.child({ plugin: 'scaffolder' });
  const jobProcessor = new JobProcessor();

  router
    .get('/v1/job/:jobId/stage/:index/log', ({ params }, res) => {
      const job = jobProcessor.get(params.jobId);

      if (!job) {
        res.status(404).send({ error: 'job not found' });
        return;
      }

      const { log } = job.stages[Number(params.index)] ?? { log: [] };

      res.send(log.join(''));
    })
    .get('/v1/job/:jobId', ({ params }, res) => {
      const job = jobProcessor.get(params.jobId);

      if (!job) {
        res.status(404).send({ error: 'job not found' });
        return;
      }

      res.send({
        id: job.id,
        metadata: {
          ...job.context,
          logger: undefined,
          logStream: undefined,
        },
        status: job.status,
        stages: job.stages.map(stage => ({
          ...stage,
          handler: undefined,
        })),
        error: job.error,
      });
    })
    .post('/v1/jobs', async (req, res) => {
      const template: TemplateEntityV1alpha1 = req.body.template;
      const values: RequiredTemplateValues & Record<string, JsonValue> =
        req.body.values;

      const job = jobProcessor.create({
        entity: template,
        values,
        stages: [
          {
            name: 'Prepare the skeleton',
            handler: async ctx => {
              const preparer = preparers.get(ctx.entity);
              const skeletonDir = await preparer.prepare(ctx.entity, {
                logger: ctx.logger,
              });
              return { skeletonDir };
            },
          },
          {
            name: 'Run the templater',
            handler: async (ctx: StageContext<{ skeletonDir: string }>) => {
              const resultDir = await templater.run({
                directory: ctx.skeletonDir,
                dockerClient,
                logStream: ctx.logStream,
                values: ctx.values,
              });

              return { resultDir };
            },
          },
          {
            name: 'Publish template',
            handler: async (ctx: StageContext<{ resultDir: string }>) => {
              ctx.logger.info('Should not store the template');
              const { remoteUrl } = await githubPulisher.publish({
                values: ctx.values,
                directory: ctx.resultDir,
              });
              return { remoteUrl };
            },
          },
        ],
      });

      res.status(201).json({ id: job.id });

      jobProcessor.run(job);
    });

  const app = express();
  app.set('logger', logger);
  app.use('/', router);

  return app;
}
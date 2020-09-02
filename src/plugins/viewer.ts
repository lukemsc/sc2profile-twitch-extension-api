import { FastifyPlugin } from 'fastify';
import fp from 'fastify-plugin';
import { PlayerObject } from '../@types/fastify';
import StarCraft2API from 'starcraft2-api';

interface DataObject {
  segment: string;
  data: object;
  ttl: number;
}

interface ViewerOptions {
  ttl: number;
}

const ranks = [
  'bronze',
  'silver',
  'gold',
  'platinum',
  'diamond',
  'master',
  'grandmaster',
] as string[];

const viewerPlugin: FastifyPlugin<ViewerOptions> =
  (server, { ttl }: ViewerOptions, next) => {
    const cache = server.redis;
    const cacheActive = Boolean(server.redis);

    const isDataCached = async (segment: string) => {
      return cacheActive
        ? await server.redis.get(segment) ? true : false
        : Promise.resolve(false);
    };

    const cacheObject = async ({ segment, data, ttl }: DataObject) => {
      if (!cacheActive) return 'Object not cached (Cache disabled)';
      await cache.set(segment, JSON.stringify(data));
      await cache.expire(segment, ttl);
      return 'Object cached successfully';
    };

    const getCachedObject = (segment: string) =>
      cacheActive
        ? server.redis.get(segment)
        : JSON.stringify({});

    const sleep = (ms: number) => {
      server.log.info(`Sleeping for ${ms}ms...`);
      new Promise(resolve => setTimeout(resolve, ms));
    };

    const calculateHighestRank = (soloRank?: string, teamRank?: string) => {
      const soloRankIndex = soloRank
        ? ranks.indexOf(soloRank.toLowerCase())
        : -1;

      const teamRankIndex = teamRank
        ? ranks.indexOf(teamRank.toLowerCase())
        : -1;

      return soloRankIndex > teamRankIndex
        ? soloRank
          ? soloRank.toLowerCase()
          : ''
        : teamRank
          ? teamRank.toLowerCase()
          : '';
    };

    const calculateWins = (seasonSnapshot: any) =>
      Object.keys(seasonSnapshot).map(
        gameMode => seasonSnapshot[gameMode].totalWins,
      ).reduce((sum, value) => sum + value);

    const calculateSeasonWinRatio = (apiData: any) => {
      const wins = calculateWins(apiData.seasonSnapshot);
      const totalGames = apiData.totalRankedSeasonGamesPlayed;
      return Math.round(Number(wins) * 100 / totalGames);
    };

    const getHeading = (apiData: any, regionName: string) => {
      const {
        summary,
        career,
      } = apiData.data;

      return {
        portrait: {
          url: summary.portrait,
          frame: calculateHighestRank(
            career.current1v1LeagueName,
            career.currentBestTeamLeagueName,
          ),
        },
        player: {
          clan: {
            name: summary.clanName,
            tag: summary.clanTag,
          },
          name: summary.displayName,
          server: regionName,
        },
      };
    };

    const getStats = (apiData: any) => {
      const {
        snapshot,
        career,
      } = apiData.data;

      return {
        totalCareerGames: career?.totalCareerGames || 0,
        totalRankedGamesThisSeason: snapshot?.totalRankedSeasonGamesPlayed,
        seasonWinRatio: calculateSeasonWinRatio(snapshot) || 0,
        highestSoloRank: career?.best1v1Finish?.leagueName?.toLowerCase() || '',
        highestTeamRank: career?.bestTeamFinish?.leagueName?.toLowerCase() || '',
      };
    };

    const getPlayerLadderInfo = (apiData: any, profileId: number) => {
      const {
        ladderTeams,
        ranksAndPools,
        currentLadderMembership,
      } = apiData.data;

      const {
        rank,
        mmr,
      } = ranksAndPools[0];
      const localizedGameMode = currentLadderMembership.localizedGameMode.split(' ');
      const mode = localizedGameMode[0].toLowerCase();
      const rankName = localizedGameMode[1].toLowerCase() === 'random'
        ? localizedGameMode[2].toLowerCase()
        : localizedGameMode[1].toLowerCase();

      const playerLadderData = ladderTeams.filter((ladderTeam: any) =>
        ladderTeam.teamMembers.some((teamMember: any) =>
          teamMember.id === profileId),
      )[0];

      const {
        wins,
        losses,
        teamMembers,
      } = playerLadderData;
      const teamMemberNames = teamMembers.map((teamMember:any) => teamMember.displayName);

      const race = teamMembers.filter((teamMember: any) =>
        teamMember.id === profileId,
      )[0].favoriteRace;

      return {
        mode,
        rank: rankName,
        wins,
        losses,
        race,
        mmr,
        divisionRank: rank,
        teamMembers: teamMemberNames,
      };
    };

    const getLadderData = async (profile: PlayerObject, ladderId: number, index: number) => {
      await sleep((index + 1) * 1000);
      const { profileId } = profile;
      const ladderApiData = await server.sas.getLadder(profile, ladderId);
      const playerLadderInfo = getPlayerLadderInfo(ladderApiData, profileId as number);
      return playerLadderInfo;
    };

    const getSnapshot = (apiData: any, profile: any) => {
      const { allLadderMemberships } = apiData.data;
      const ladderIds =
        allLadderMemberships.map((ladderMembership: any) => ladderMembership.ladderId);

      return Promise.all(
        ladderIds.map(
          async (ladderId: any, index: number) =>
            await getLadderData(profile, ladderId, index),
        ),
      );
    };

    const getMatchHistory = (apiData: any) => {
      const data = apiData.data.matches as any[];
      const filteredMatchHistory = data.filter(match => match.type !== 'Custom');

      return filteredMatchHistory.map(matchObject => ({
        mapName: matchObject.map,
        mode: matchObject.type,
        result: matchObject.decision.toLowerCase(),
        date: matchObject.date * 1000,
      }));
    };

    const getProfileData = async (profile: PlayerObject, index:number) => {
      try {
        const profileData = await server.sas.getProfile(profile);
        await sleep((index + 1) * 1000);
        const matchHistoryData = await server.sas.getLegacyMatchHistory(profile);
        await sleep((index + 1) * 1000);
        const ladderSummaryData = await server.sas.getLadderSummary(profile);
        const regionName = StarCraft2API.getRegionNameById(profile.regionId)[0];
        const heading = getHeading(profileData, regionName);
        await sleep((index + 1) * 1000);
        const snapshot = await getSnapshot(ladderSummaryData, profile);
        const stats = getStats(profileData);
        const history = getMatchHistory(matchHistoryData);

        return {
          heading,
          details: {
            snapshot,
            stats,
            history,
          },
        };
      } catch {
        return {};
      }
    };

    const getFreshData = async (profiles: PlayerObject[], cacheSegment: string) => {
      try {
        const profileData = await Promise.all(
          profiles.map(async (profile, index) =>
            await getProfileData(profile, index),
          ),
        );

        cacheActive && cacheObject({
          segment: cacheSegment,
          data: {
            profiles: profileData,
          },
          ttl,
        });

        return {
          profiles: profileData,
        };
      } catch {
        return [];
      }
    };

    interface GetDataParams {
      channelId: string;
      profiles: PlayerObject[];
      refresh?: boolean;
    }

    const getData = async ({ channelId, profiles }: GetDataParams) => {
      const cacheSegment = `viewer-${channelId}`;
      const isItCached = await isDataCached(cacheSegment);

      if (cacheActive && isItCached) {
        const cachedData = await getCachedObject(cacheSegment);
        return JSON.parse(cachedData);
      }

      const data = await getFreshData(profiles, cacheSegment);
      return data;
    };

    server.decorate('viewer', {
      getData,
      getFreshData,
    });

    next();
  };

export default fp(viewerPlugin);

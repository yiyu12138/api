import { AppIntentManager, AppIntentProtocol, Widget } from 'scripting'

const FORCE_REFRESH_KEY = 'api_balance.local.v1.force_refresh'

export const RefreshAPIBalanceIntent = AppIntentManager.register({
  name: 'RefreshAPIBalanceIntent',
  protocol: AppIntentProtocol.AppIntent,
  perform: async () => {
    Storage.set(FORCE_REFRESH_KEY, true, { shared: true })
    Widget.reloadAll()
  },
})

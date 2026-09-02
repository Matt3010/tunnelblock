from strategies.base import AppStrategy


class InstagramStrategy(AppStrategy):
    """Observation-only strategy for the official Instagram application.

    No request or response mutation is enabled. Future ad-specific behavior
    belongs here, not in the transport/proxy layer.
    """

    pass

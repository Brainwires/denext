/**
 * @since 7.1.0
 */
export declare enum EventAvailability {
    /**
     * @platform iOS
     * @since 7.1.0
     */
    NOT_SUPPORTED = -1,
    /**
     * @platform Android, iOS
     * @since 7.1.0
     */
    BUSY = 0,
    /**
     * @platform Android, iOS
     * @since 7.1.0
     */
    FREE = 1,
    /**
     * @platform Android, iOS
     * @since 7.1.0
     */
    TENTATIVE = 2,
    /**
     * @platform iOS
     * @since 7.1.0
     */
    UNAVAILABLE = 3
}
